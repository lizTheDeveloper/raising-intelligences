import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestServer, type TestServer } from "./helpers/test-server.js";
import { TestClient } from "./helpers/socket-client.js";
import { claimsFor, newCampusKeyPair, signPass } from "./helpers/campus-pass-fixture.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { bannableIdentifiers, confirmCase, dedupeIdentifiers, logIp, preserveEvidence, viewEvidence } from "../src/safety/child-safety/vault.js";
import { InMemoryChildSafetyStore } from "../src/safety/child-safety/store.js";
import { logger } from "../src/logger.js";
import { resolveCampusIdentity } from "../src/security/campus-identity.js";
import { buildReportPackage, reporterInfoFromEnv } from "../src/safety/child-safety/report.js";

// Synthetic only: never real player text.
const FIXTURE = "TEST FIXTURE: synthetic flagged text, not real content";
const keys = newCampusKeyPair();
process.env.CAMPUS_PASS_PUBLIC_KEY = keys.publicKeyB64;
process.env.CHILD_SAFETY_EVIDENCE_KEY ??= randomBytes(32).toString("base64");

let ipCounter = 10;
/** A fresh client IP per call keeps the per-IP rate limits out of the way. */
const freshIp = () => `198.51.100.${ipCounter++}`;

function passFor(sub: string, name = "Synthetic Student"): string {
  return signPass(claimsFor({ sub, name }), keys.privateKeyB64);
}

/** Flags every moderated message; every other fetch (the test's own HTTP calls) passes through. */
function mockModerationFlag() {
  process.env.OPENAI_API_KEY = "sk-test";
  const real = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith("https://api.openai.com/")
      ? new Response(JSON.stringify({
          model: "omni-moderation-2024-09-26",
          results: [{ flagged: true, categories: { "sexual/minors": true }, category_scores: { "sexual/minors": 0.97 } }],
        }), { status: 200 })
      : real(url as string, init));
}

describe("campus web cabinet (server)", () => {
  let server: TestServer;
  const clients: TestClient[] = [];
  const originalOpenAi = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    server = await createTestServer("campus-cabinet");
  });
  afterAll(async () => {
    clients.forEach((c) => c.close());
    await server.stop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAi;
  });

  const post = (path: string, body: unknown, ip = freshIp()) =>
    fetch(`${server.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify(body),
    });

  async function exchange(sub: string): Promise<string> {
    const res = await post("/api/campus-pass", { pass: passFor(sub) });
    expect(res.status).toBe(200);
    return (await res.json()).identity as string;
  }

  /** A solo REST message, end to end (moderation flags it before any LLM call). */
  async function restMessage(gameId: string, sender: "parent1" | "parent2", ip: string, identity?: string): Promise<void> {
    const live = server.games.get(gameId)!;
    if (live.phase !== "ended") server.games.set(gameId, { ...live, phase: "family_chat" });
    const res = await fetch(`${server.baseUrl}/api/game/${gameId}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Forwarded-For": ip, "User-Agent": "SyntheticUA",
        ...(identity ? { "X-Campus-Identity": identity } : {}),
      },
      body: JSON.stringify({ sender, content: FIXTURE }),
    });
    await res.text();
  }

  /** A socket PARENT_MESSAGE, end to end; resolves once the server has ended the session on the flag. */
  async function socketFlag(c: TestClient, gameId: string): Promise<void> {
    const live = server.games.get(gameId)!;
    server.games.set(gameId, { ...live, phase: "family_chat" });
    const ended = c.waitFor<{ error: string }>(E.ERROR, (e) => e.error === "This session has ended.");
    c.emit(E.PARENT_MESSAGE, { content: FIXTURE });
    await ended;
  }

  const caseFor = (gameId: string) => [...server.memRepo.childSafety.cases.values()].find((x) => x.gameRef === gameId)!;

  async function socketClient(ip = freshIp()): Promise<TestClient> {
    // A forwarded IP per seat, so seats get distinct server-observed IPs.
    const c = new TestClient(server.baseUrl, { extraHeaders: { "X-Forwarded-For": ip } });
    await c.connected();
    clients.push(c);
    return c;
  }

  // ── Framing ────────────────────────────────────────────────────────────────

  it("lets campus frame the game: frame-ancestors campus, no X-Frame-Options, other headers kept", async () => {
    const res = await fetch(`${server.baseUrl}/health`, { headers: { "X-Forwarded-For": freshIp() } });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' https://campus.themultiverse.school");
    expect(csp.match(/frame-ancestors/g)).toHaveLength(1);
    expect(csp).toContain("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  // ── Exchange ───────────────────────────────────────────────────────────────

  it("trades a valid pass for an opaque identity, and refuses a replay or a bad pass", async () => {
    const pass = passFor("@exchange-one:themultiverse.school", "Synthetic One");
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    let res = await post("/api/campus-pass", { pass });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ identity: expect.any(String), name: "Synthetic One", sub: "@exchange-one:themultiverse.school" });
    expect(body.identity).not.toContain(pass.slice(4, 20));
    expect(body.identity).toMatch(/^[A-Za-z0-9_-]{43}$/);

    res = await post("/api/campus-pass", { pass });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "pass_refused" });
    res = await post("/api/campus-pass", { pass: "cps.bad.pass" });
    expect(await res.json()).toEqual({ error: "pass_refused" });
    res = await post("/api/campus-pass", {});
    expect(res.status).toBe(400);

    // Never logged: only the jti.
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(pass);
    expect(logged).toContain("campus_pass_exchanged");
  });

  it("an identity outlives the pass and maps back to the campus id", async () => {
    const identity = await exchange("@persist:themultiverse.school");
    expect(await resolveCampusIdentity(server.memRepo, identity)).toEqual({ sub: "@persist:themultiverse.school", name: "Synthetic Student" });
    expect(await resolveCampusIdentity(server.memRepo, identity, Date.now() + 13 * 60 * 60 * 1000)).toBeNull();
    expect(await resolveCampusIdentity(server.memRepo, identity.slice(0, -1) + (identity.endsWith("A") ? "B" : "A"))).toBeNull();
  });

  it("a banned IP cannot exchange a pass", async () => {
    await server.memRepo.banIp("203.0.113.250", "test");
    const res = await post("/api/campus-pass", { pass: passFor("@banned-ip:themultiverse.school") }, "203.0.113.250");
    expect(res.status).toBe(403);
  });

  // ── REST game ──────────────────────────────────────────────────────────────

  it("a REST game with a campus identity stores the verified campus id and logs it verified", async () => {
    const sub = "@rest-solo:themultiverse.school";
    const identity = await exchange(sub);
    const ip = freshIp();
    const res = await post("/api/game", { childName: "Testkid", campusIdentity: identity }, ip);
    expect(res.status).toBe(200);
    const { gameId, campus } = await res.json();
    expect(campus).toBe("verified");
    expect(await server.memRepo.campusSubForSeat(gameId, "parent1")).toBe(sub);
    // Solo: one person plays both parents, so the campus id owns both seats.
    expect(await server.memRepo.campusSubForSeat(gameId, "parent2")).toBe(sub);
    const rows = await server.memRepo.childSafety.ipLogForGame(gameId, 0);
    expect(rows).toEqual([expect.objectContaining({ ip, event: "game_create", accountId: sub, accountVerified: true })]);
  });

  it("an unknown or expired identity is ignored: play proceeds anonymously and the client is told", async () => {
    const res = await post("/api/game", { childName: "Testkid", campusIdentity: "not-a-real-identity-token-aaaaaaaaaaaaaaaa" });
    expect(res.status).toBe(200);
    const { gameId, campus } = await res.json();
    expect(campus).toBe("unknown");
    expect(await server.memRepo.campusSubForSeat(gameId, "parent1")).toBeNull();
    const rows = await server.memRepo.childSafety.ipLogForGame(gameId, 0);
    expect(rows[0]).toMatchObject({ accountId: null, accountVerified: false });

    const plain = await (await post("/api/game", { childName: "Testkid" })).json();
    expect(plain.campus).toBeUndefined();
  });

  it("flag → verified matrix identifier → confirm bans it → a new REST game with that campus id is refused", async () => {
    const sub = "@rest-flagged:themultiverse.school";
    const identity = await exchange(sub);
    const ip = freshIp();
    const { gameId } = await (await post("/api/game", { childName: "Testkid", campusIdentity: identity }, ip)).json();

    mockModerationFlag();
    // Sender parent2: in a solo game the same person types for both parents.
    // The request proves the identity (X-Campus-Identity), so its row is verified.
    await restMessage(gameId, "parent2", ip, identity);
    vi.restoreAllMocks();
    expect(server.games.get(gameId)!.phase).toBe("ended");

    const c = caseFor(gameId);
    expect(c.identifiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "campus", value: sub, verified: true, role: "flagged", slot: "parent2" }),
    ]));
    const { evidence } = await viewEvidence(server.memRepo.childSafety, c.id, "reviewer", null);
    expect(evidence.ipHistory.some((h) => h.accountId === sub && h.accountVerified === true)).toBe(true);

    const confirmed = await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, (i, why) => server.memRepo.banIp(i, why));
    expect(confirmed.banned).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "campus", value: sub })]));
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "campus", value: sub })).toBe(true);

    // The report package lists it as a verified identifier of the sender.
    const view = await viewEvidence(server.memRepo.childSafety, c.id, "reviewer", null);
    const pkg = buildReportPackage(view.case, view.evidence, reporterInfoFromEnv());
    expect(pkg.reportedPerson.identifiers).toEqual(expect.arrayContaining([{ kind: "campus", value: sub }]));
    expect(pkg.reportedPerson.claimedUnverified).toEqual([]);
    expect(pkg.reportedPerson.accountVerified).toBe(true);

    // A fresh pass for the same campus id (from a new, unbanned IP) cannot start a game.
    const again = await exchange(sub);
    const refused = await post("/api/game", { childName: "Testkid", campusIdentity: again });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Forbidden" });
  });

  // ── Socket games ───────────────────────────────────────────────────────────

  it("socket create and join attach each seat's verified campus id; only the flagged seat's is banned", async () => {
    const subA = "@seat-a:themultiverse.school";
    const subB = "@seat-b:themultiverse.school";
    const [idA, idB] = [await exchange(subA), await exchange(subB)];
    const ipA = freshIp();
    const ipB = freshIp();
    const a = await socketClient(ipA);
    const joinedA = a.once<{ gameId: string; slot: string; campus?: string }>(E.JOINED);
    a.emit(E.CREATE_GAME, { childName: "Testkid", displayName: "A", campusIdentity: idA });
    const ja = await joinedA;
    expect(ja.campus).toBe("verified");

    const b = await socketClient(ipB);
    const joinedB = b.once<{ gameId: string; slot: string; playerToken: string; campus?: string }>(E.JOINED);
    b.emit(E.JOIN_GAME, { gameId: ja.gameId, displayName: "B", campusIdentity: idB });
    const jb = await joinedB;
    expect(jb.slot).toBe("parent2");
    expect(jb.campus).toBe("verified");

    const players = await server.memRepo.loadPlayers(ja.gameId);
    expect(players.find((p) => p.slot === "parent1")?.campusSub).toBe(subA);
    expect(players.find((p) => p.slot === "parent2")?.campusSub).toBe(subB);
    expect(await server.memRepo.campusSubForSeat(ja.gameId, "parent2")).toBe(subB);

    const rows = await server.memRepo.childSafety.ipLogForGame(ja.gameId, 0);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "socket_create", slot: "parent1", accountId: subA, accountVerified: true }),
      expect.objectContaining({ event: "socket_join", slot: "parent2", accountId: subB, accountVerified: true }),
    ]));

    mockModerationFlag();
    await socketFlag(b, ja.gameId);
    vi.restoreAllMocks();
    const c = caseFor(ja.gameId);
    expect(c.identifiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "campus", value: subB, verified: true, role: "flagged" }),
      expect.objectContaining({ kind: "campus", value: subA, verified: true, role: "participant" }),
    ]));
    await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, (i, why) => server.memRepo.banIp(i, why));
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "campus", value: subB })).toBe(true);
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "campus", value: subA })).toBe(false);

    // The banned campus id can neither create nor join over the socket.
    const idB2 = await exchange(subB);
    const c3 = await socketClient();
    const err = c3.once<{ error: string }>(E.ERROR);
    c3.emit(E.CREATE_GAME, { childName: "Testkid", campusIdentity: idB2 });
    expect((await err).error).toBe("Forbidden");
    const err2 = c3.once<{ error: string }>(E.ERROR);
    c3.emit(E.JOIN_GAME, { gameId: ja.gameId, campusIdentity: idB2 });
    expect((await err2).error).toBe("Forbidden");
    // Nor can the banned seat come back with its own reconnect token, without sending any identity.
    const err3 = c3.once<{ error: string }>(E.ERROR);
    c3.emit(E.JOIN_GAME, { gameId: ja.gameId, playerToken: jb.playerToken });
    expect((await err3).error).toBe("Forbidden");
  });

  it("security: claiming a co-player's campus id never frames them into a ban", async () => {
    const victim = "@victim:themultiverse.school";
    // The attacker creates a game claiming the victim's campus id as a plain userId…
    const atk = await socketClient();
    const aJoined = atk.once<{ gameId: string }>(E.JOINED);
    atk.emit(E.CREATE_GAME, { childName: "Testkid", userId: victim });
    const ag = await aJoined;
    // …and the victim joins it with their real, verified campus identity.
    const idV = await exchange(victim);
    const v = await socketClient();
    const vJoined = v.once<{ slot: string; campus?: string }>(E.JOINED);
    v.emit(E.JOIN_GAME, { gameId: ag.gameId, campusIdentity: idV });
    expect(await vJoined).toMatchObject({ slot: "parent2", campus: "verified" });
    // An any-case variant of a campus id is dropped as a claim too.
    const atk2 = await socketClient();
    const e2 = atk2.once<{ gameId: string }>(E.JOINED);
    atk2.emit(E.CREATE_GAME, { childName: "Testkid", userId: "@Victim:TheMultiverse.School" });
    const g2 = await e2;
    expect((await server.memRepo.loadPlayers(g2.gameId))[0].userId).toBeUndefined();

    // The claim never reached the attacker's seat or the IP log.
    expect((await server.memRepo.loadPlayers(ag.gameId)).find((p) => p.slot === "parent1")?.userId).toBeUndefined();

    // The attacker (parent1) is flagged.
    mockModerationFlag();
    await socketFlag(atk, ag.gameId);
    vi.restoreAllMocks();
    const c = caseFor(ag.gameId);
    // The victim appears only as a verified participant, never flagged.
    const victimIds = c.identifiers.filter((i) => i.value.toLowerCase() === victim);
    expect(victimIds).toEqual([expect.objectContaining({ kind: "campus", role: "participant", verified: true })]);
    expect(bannableIdentifiers(c).some((i) => i.value.toLowerCase() === victim)).toBe(false);
    await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, async () => {});
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "campus", value: victim })).toBe(false);
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "matrix", value: victim })).toBe(false);
    // The victim can still start games.
    expect((await post("/api/game", { childName: "Testkid", campusIdentity: idV })).status).toBe(200);
  });

  // ── Fix round 1: a seat's verified id belongs to its OCCUPANT, not its slot ─

  it("security: taking over a seat a verified student left never gets them flagged or banned", async () => {
    const victim = "@seat-victim:themultiverse.school";
    const host = await socketClient();
    const hJoined = host.once<{ gameId: string }>(E.JOINED);
    host.emit(E.CREATE_GAME, { childName: "Testkid" });
    const g = await hJoined;
    // The victim takes parent2 with a verified campus identity, then leaves.
    const v = await socketClient();
    const vJoined = v.once<{ slot: string }>(E.JOINED);
    v.emit(E.JOIN_GAME, { gameId: g.gameId, campusIdentity: await exchange(victim) });
    expect((await vJoined).slot).toBe("parent2");
    const gone = host.waitFor<{ players: Array<{ slot: string; connected: boolean }> }>(E.LOBBY,
      (l) => l.players.some((p) => p.slot === "parent2" && !p.connected));
    v.close();
    await gone;
    // The attacker follows the invite link and reclaims parent2.
    const atk = await socketClient();
    const aJoined = atk.once<{ slot: string }>(E.JOINED);
    atk.emit(E.JOIN_GAME, { gameId: g.gameId });
    expect((await aJoined).slot).toBe("parent2");
    // The seat's campus id went with the victim.
    expect((await server.memRepo.loadPlayers(g.gameId)).find((p) => p.slot === "parent2")?.campusSub).toBeUndefined();

    mockModerationFlag();
    await socketFlag(atk, g.gameId);
    vi.restoreAllMocks();
    const c = caseFor(g.gameId);
    expect(c.identifiers.filter((i) => i.value === victim)).toEqual([
      expect.objectContaining({ kind: "campus", role: "participant", verified: true, slot: "parent2" }),
    ]);
    expect(bannableIdentifiers(c).some((i) => i.value === victim)).toBe(false);
    const conf = await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, async () => {});
    expect(conf.banned.some((b) => b.value === victim)).toBe(false);
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "campus", value: victim })).toBe(false);
  });

  it("security: a solo game's creator is never flagged for a message they didn't send (REST by id, or a socket joiner)", async () => {
    const creator = "@solo-creator:themultiverse.school";
    const identity = await exchange(creator);
    // (1) Anyone with the game id can post to the REST message route; without
    // the creator's identity token their message is not the creator's.
    const g1 = (await (await post("/api/game", { childName: "Testkid", campusIdentity: identity })).json()).gameId as string;
    mockModerationFlag();
    await restMessage(g1, "parent1", freshIp());
    vi.restoreAllMocks();
    let c = caseFor(g1);
    expect(c.identifiers.filter((i) => i.value === creator)).toEqual([expect.objectContaining({ kind: "campus", role: "participant" })]);
    expect(bannableIdentifiers(c).some((i) => i.value === creator)).toBe(false);

    // (2) A socket joiner takes parent1 of the solo game by its id.
    const g2 = (await (await post("/api/game", { childName: "Testkid", campusIdentity: identity })).json()).gameId as string;
    const atk = await socketClient();
    const joined = atk.once<{ slot: string }>(E.JOINED);
    atk.emit(E.JOIN_GAME, { gameId: g2 });
    expect((await joined).slot).toBe("parent1");
    mockModerationFlag();
    await socketFlag(atk, g2);
    vi.restoreAllMocks();
    c = caseFor(g2);
    expect(c.identifiers.filter((i) => i.value === creator)).toEqual([expect.objectContaining({ kind: "campus", role: "participant" })]);
    await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, async () => {});
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "campus", value: creator })).toBe(false);
  });

  it("a token rejoin waiting on its campus ban check never drops a co-player who joined meanwhile", async () => {
    const sub = "@race-seat:themultiverse.school";
    const a = await socketClient();
    const aJoined = a.once<{ gameId: string; playerToken: string }>(E.JOINED);
    a.emit(E.CREATE_GAME, { childName: "Testkid", campusIdentity: await exchange(sub) });
    const ja = await aJoined;

    // Hold the campus ban check of the rejoin below.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    const store = server.memRepo.childSafety;
    const orig = store.isIdentifierBanned.bind(store);
    vi.spyOn(store, "isIdentifierBanned").mockImplementation(async (id) => {
      if (id.kind === "campus") { held++; await gate; }
      return orig(id);
    });

    const a2 = await socketClient();
    const rejoined = a2.once<{ slot: string }>(E.JOINED);
    a2.emit(E.JOIN_GAME, { gameId: ja.gameId, playerToken: ja.playerToken });
    await vi.waitFor(() => expect(held).toBe(1));
    // While it waits, a co-player joins.
    const b = await socketClient();
    const bJoined = b.once<{ slot: string }>(E.JOINED);
    b.emit(E.JOIN_GAME, { gameId: ja.gameId });
    expect((await bJoined).slot).toBe("parent2");
    release();
    expect((await rejoined).slot).toBe("parent1");
    vi.restoreAllMocks();
    expect(server.sessions.get(ja.gameId)!.players.map((p) => p.slot).sort()).toEqual(["parent1", "parent2"]);
  });

  it("a failure storing the identity after the jti is spent answers 503 JSON; one storing the game's campus id never blocks the game", async () => {
    const save = vi.spyOn(server.memRepo, "saveCampusIdentity").mockRejectedValueOnce(new Error("db down (synthetic)"));
    const res = await post("/api/campus-pass", { pass: passFor("@issue-fails:themultiverse.school") });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "campus_identity_unavailable" });
    save.mockRestore();

    const identity = await exchange("@record-fails:themultiverse.school");
    vi.spyOn(server.memRepo, "recordGameCampusSub").mockRejectedValueOnce(new Error("db down (synthetic)"));
    const created = await post("/api/game", { childName: "Testkid", campusIdentity: identity });
    expect(created.status).toBe(200);
    const { gameId } = await created.json();
    // Not stored, so not claimed in the IP log either.
    expect((await server.memRepo.childSafety.ipLogForGame(gameId, 0))[0]).toMatchObject({ accountId: null, accountVerified: false });
  });

  it("a seat that joined before its cabinet sign-in finished takes the campus id on rejoin", async () => {
    const sub = "@late-sign-in:themultiverse.school";
    const a = await socketClient();
    const joined = a.once<{ gameId: string; slot: string; playerToken: string; campus?: string }>(E.JOINED);
    a.emit(E.CREATE_GAME, { childName: "Testkid" });
    const j = await joined;
    expect(j.campus).toBeUndefined();
    expect(await server.memRepo.campusSubForSeat(j.gameId, "parent1")).toBeNull();
    const identity = await exchange(sub);
    const a2 = await socketClient();
    const rejoined = a2.once<{ slot: string; campus?: string }>(E.JOINED);
    a2.emit(E.JOIN_GAME, { gameId: j.gameId, playerToken: j.playerToken, campusIdentity: identity });
    expect(await rejoined).toMatchObject({ slot: "parent1", campus: "verified" });
    expect(await server.memRepo.campusSubForSeat(j.gameId, "parent1")).toBe(sub);
    const rows = await server.memRepo.childSafety.ipLogForGame(j.gameId, 0);
    expect(rows.at(-1)).toMatchObject({ event: "socket_rejoin", accountId: sub, accountVerified: true });
  });

  it("a client-claimed userId stays unverified (and an unknown identity is reported back on the socket)", async () => {
    const claimed = "@claimed-only:matrix.example";
    const a = await socketClient();
    const joined = a.once<{ gameId: string; campus?: string }>(E.JOINED);
    a.emit(E.CREATE_GAME, { childName: "Testkid", userId: claimed, campusIdentity: "bogus-identity" });
    const j = await joined;
    expect(j.campus).toBe("unknown");
    const rows = await server.memRepo.childSafety.ipLogForGame(j.gameId, 0);
    expect(rows[0]).toMatchObject({ accountId: claimed, accountVerified: false });
    expect(await server.memRepo.campusSubForSeat(j.gameId, "parent1")).toBeNull();

    mockModerationFlag();
    await socketFlag(a, j.gameId);
    vi.restoreAllMocks();
    const c = caseFor(j.gameId);
    const matrix = c.identifiers.filter((i) => i.kind === "matrix");
    expect(matrix).toEqual([expect.objectContaining({ value: claimed, verified: false })]);
    await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, async () => {});
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "matrix", value: claimed })).toBe(false);
  });
});

describe("identifier dedupe keeps role and verified paired", () => {
  it("an unverified flagged sighting never makes a verified participant bannable", () => {
    const merged = dedupeIdentifiers([
      { kind: "campus", value: "@v:themultiverse.school", role: "participant", verified: true, slot: "parent2" },
      { kind: "campus", value: "@v:themultiverse.school", role: "flagged", verified: false, slot: "parent1" },
    ]);
    expect(bannableIdentifiers({ identifiers: merged, ipAddress: null })).toEqual([]);
    expect(merged).toHaveLength(2);
  });

  it("verified sightings still merge, flagged winning (a shared device is the sender's too)", () => {
    const merged = dedupeIdentifiers([
      { kind: "ip", value: "198.51.100.5", role: "participant", verified: true, slot: "parent2" },
      { kind: "ip", value: "198.51.100.5", role: "flagged", verified: true, slot: "parent1" },
    ]);
    expect(merged).toEqual([expect.objectContaining({ role: "flagged", verified: true, slot: "parent1" })]);
  });
});

describe("scene-reader flags infer the seat's occupant", () => {
  const V = "@scene-v:themultiverse.school";
  async function sceneCase(rows: Array<{ slot: string; occupant: string; campus?: boolean }>) {
    const store = new InMemoryChildSafetyStore();
    for (const r of rows) {
      await logIp(store, { ip: "198.51.100.77", gameRef: "g-scene", event: "message", slot: r.slot, occupant: r.occupant,
        ...(r.campus ? { accountId: V, accountVerified: true } : {}) });
    }
    const { caseId } = await preserveEvidence(store, {
      source: "ri_scene", content: FIXTURE, context: [], categories: ["scene_reader:block"], gameRef: "g-scene",
      ipAddress: null, userAgent: null, sender: "parent1", requestIpIsSender: false,
    });
    return (await store.getCase(caseId))!;
  }

  it("one occupant in the seat: their verified campus id is flagged (a genuine offender stays bannable)", async () => {
    const c = await sceneCase([{ slot: "parent1", occupant: "seat:a", campus: true }, { slot: "parent1", occupant: "seat:a", campus: true }]);
    expect(bannableIdentifiers(c).some((i) => i.kind === "campus" && i.value === V)).toBe(true);
  });

  it("the seat changed hands: campus ids stay participants for a reviewer to include", async () => {
    const c = await sceneCase([{ slot: "parent1", occupant: "seat:a", campus: true }, { slot: "parent1", occupant: "seat:b" }]);
    expect(bannableIdentifiers(c).some((i) => i.kind === "campus")).toBe(false);
    expect(c.identifiers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "campus", value: V, role: "participant", verified: true })]));
  });
});
