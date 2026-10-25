import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestServer, type TestServer } from "./helpers/test-server.js";
import { TestClient } from "./helpers/socket-client.js";
import { claimsFor, newCampusKeyPair, signPass } from "./helpers/campus-pass-fixture.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { moderateParentMessage } from "../src/safety/moderation.js";
import { confirmCase, viewEvidence } from "../src/safety/child-safety/vault.js";
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

function mockModerationFlag() {
  process.env.OPENAI_API_KEY = "sk-test";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        model: "omni-moderation-2024-09-26",
        results: [{ flagged: true, categories: { "sexual/minors": true }, category_scores: { "sexual/minors": 0.97 } }],
      }),
      { status: 200 },
    ),
  );
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
    const state = server.games.get(gameId)!;

    mockModerationFlag();
    // Sender parent2: in a solo game the same person types for both parents.
    const r = await moderateParentMessage({
      repo: server.memRepo, games: server.games, state, sender: "parent2", content: FIXTURE, ipAddress: ip, userAgent: "SyntheticUA",
    });
    vi.restoreAllMocks();
    expect(r.blocked).toBe(true);

    const c = [...server.memRepo.childSafety.cases.values()].find((x) => x.gameRef === gameId)!;
    expect(c.identifiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "matrix", value: sub, verified: true, role: "flagged", slot: "parent2" }),
    ]));
    const { evidence } = await viewEvidence(server.memRepo.childSafety, c.id, "reviewer", null);
    expect(evidence.ipHistory.some((h) => h.accountId === sub && h.accountVerified === true)).toBe(true);

    const confirmed = await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, (i, why) => server.memRepo.banIp(i, why));
    expect(confirmed.banned).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "matrix", value: sub })]));
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "matrix", value: sub })).toBe(true);

    // The report package lists it as a verified identifier of the sender.
    const view = await viewEvidence(server.memRepo.childSafety, c.id, "reviewer", null);
    const pkg = buildReportPackage(view.case, view.evidence, reporterInfoFromEnv());
    expect(pkg.reportedPerson.identifiers).toEqual(expect.arrayContaining([{ kind: "matrix", value: sub }]));
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
    const joinedB = b.once<{ gameId: string; slot: string; campus?: string }>(E.JOINED);
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

    const state = server.games.get(ja.gameId)!;
    mockModerationFlag();
    await moderateParentMessage({ repo: server.memRepo, games: server.games, state, sender: "parent2", content: FIXTURE, ipAddress: ipB });
    vi.restoreAllMocks();
    const c = [...server.memRepo.childSafety.cases.values()].find((x) => x.gameRef === ja.gameId)!;
    expect(c.identifiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "matrix", value: subB, verified: true, role: "flagged" }),
      expect.objectContaining({ kind: "matrix", value: subA, verified: true, role: "participant" }),
    ]));
    await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, (i, why) => server.memRepo.banIp(i, why));
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "matrix", value: subB })).toBe(true);
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "matrix", value: subA })).toBe(false);

    // The banned campus id can neither create nor join over the socket.
    const idB2 = await exchange(subB);
    const c3 = await socketClient();
    const err = c3.once<{ error: string }>(E.ERROR);
    c3.emit(E.CREATE_GAME, { childName: "Testkid", campusIdentity: idB2 });
    expect((await err).error).toBe("Forbidden");
    const err2 = c3.once<{ error: string }>(E.ERROR);
    c3.emit(E.JOIN_GAME, { gameId: ja.gameId, campusIdentity: idB2 });
    expect((await err2).error).toBe("Forbidden");
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

    const state = server.games.get(j.gameId)!;
    mockModerationFlag();
    await moderateParentMessage({ repo: server.memRepo, games: server.games, state, sender: "parent1", content: FIXTURE, ipAddress: "198.51.100.200" });
    vi.restoreAllMocks();
    const c = [...server.memRepo.childSafety.cases.values()].find((x) => x.gameRef === j.gameId)!;
    const matrix = c.identifiers.filter((i) => i.kind === "matrix");
    expect(matrix).toEqual([expect.objectContaining({ value: claimed, verified: false })]);
    await confirmCase(server.memRepo.childSafety, c.id, "reviewer", null, async () => {});
    expect(await server.memRepo.childSafety.isIdentifierBanned({ kind: "matrix", value: claimed })).toBe(false);
  });
});
