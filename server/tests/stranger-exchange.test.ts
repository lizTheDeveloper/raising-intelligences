import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { AgeVerification } from "../src/stranger/identity.js";
import { StrangerPasses } from "../src/stranger/matrix-identity.js";
import { StrangerService } from "../src/stranger/service.js";
import { TestClient, connect } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { FakeIdentity, strangerConfig } from "./helpers/fake-identity.js";

/**
 * The one moment two strangers can learn who the other is: after the report
 * card, both say yes (having read the safety notice), both still verified
 * adults, nobody reported. Then each sees the other's Matrix handle — only
 * the other's, only to them. A report at any time closes it, suspends the
 * reported account and blocks the pair.
 */

const ALICE = "@alice:multiversegames.ai";
const BOB = "@bob:multiversegames.ai";

describe("stranger handle exchange and reports", () => {
  let built: BuiltServer;
  let origin: string;
  let stranger: StrangerService;
  let repo: InMemoryGameRepository;
  const clients: TestClient[] = [];
  const savedAdmin = process.env.ADMIN_TOKEN;

  beforeEach(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    process.env.ADMIN_TOKEN = "admin-test-token";
    const cfg = strangerConfig({ joinWindowMs: 60_000 });
    repo = new InMemoryGameRepository();
    stranger = new StrangerService({
      config: () => cfg,
      passes: new StrangerPasses(),
      age: new AgeVerification({ store: repo.stranger, api: new FakeIdentity(), config: () => cfg, childSafety: repo.childSafety, pepper: "k".repeat(64) }),
      verifyMatrix: async () => null,
      store: repo.stranger,
    });
    built = buildServer({
      llm: new MockLLMClient(),
      repo,
      adminQueries: new InMemoryAdminQueries(),
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
      stranger,
    });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await built.close();
    if (savedAdmin === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = savedAdmin;
  });

  async function adult(mxid: string, outcome: "adult" | "minor" = "adult"): Promise<string> {
    const subject = await stranger.age.subjectHash(mxid);
    await repo.stranger.setVerification({ subject, outcome, livemode: true, verifiedAt: Date.now(), sessionId: `vs_${mxid}` });
    return stranger.passes.issue(mxid, "tea-party");
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${origin}/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function client(): Promise<TestClient> {
    const c = await connect(origin);
    clients.push(c);
    return c;
  }

  /** Two matched, seated strangers. */
  async function pair() {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await post("/stranger/queue/join", { pass: a, childName: "Wren", displayName: "Ash" });
    await post("/stranger/queue/join", { pass: b, childName: "Juniper", displayName: "Bea" });
    const ma = (await post("/stranger/queue/poll", { pass: a })).body;
    const mb = (await post("/stranger/queue/poll", { pass: b })).body;
    const sit = async (pass: string, m: Record<string, unknown>) => {
      const c = await client();
      const j = c.once(E.JOINED);
      c.emit(E.JOIN_GAME, { gameId: m.gameId, playerToken: m.playerToken, strangerPass: pass });
      await j;
      return c;
    };
    const A = await sit(a, ma);
    const B = await sit(b, mb);
    return { A, B, a, b, gameId: ma.gameId as string };
  }

  function toReportCard(gameId: string) {
    const s = built.games.get(gameId)!;
    built.games.set(gameId, { ...s, phase: "report_card" });
  }

  type HandleState = { mine: "yes" | "no" | null; closed: boolean; matrixId?: string; error?: string };
  const answer = async (c: TestClient, payload: Record<string, unknown>) => {
    const st = c.once<HandleState>(E.HANDLE_STATE);
    c.emit(E.HANDLE_EXCHANGE, payload);
    return st;
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("isn't offered before the report card", async () => {
    const { A } = await pair();
    const st = await answer(A, { answer: "yes", ack: true });
    expect(st.error).toBeTruthy();
    expect(st.matrixId).toBeUndefined();
  });

  it("one yes reveals nothing; two yeses reveal each to the other, privately", async () => {
    const { A, B, gameId } = await pair();
    toReportCard(gameId);
    const seenByA: unknown[] = [];
    const seenByB: unknown[] = [];
    A.socket.onAny((ev, ...args) => seenByA.push([ev, args]));
    B.socket.onAny((ev, ...args) => seenByB.push([ev, args]));
    const first = await answer(A, { answer: "yes", ack: true });
    expect(first).toMatchObject({ mine: "yes", closed: false });
    expect(first.matrixId).toBeUndefined();
    const revealToA = A.waitFor<HandleState>(E.HANDLE_STATE, (s) => !!s.matrixId);
    const second = await answer(B, { answer: "yes", ack: true });
    expect(second.matrixId).toBe(ALICE);
    expect((await revealToA).matrixId).toBe(BOB);
    await wait(50);
    // Nobody ever sees their own handle echoed, and nothing else carries either.
    expect(JSON.stringify(seenByA)).not.toContain(ALICE);
    expect(JSON.stringify(seenByB)).not.toContain(BOB);
  });

  it("yes needs the safety notice read; any no closes it; answers are final", async () => {
    const { A, B, gameId } = await pair();
    toReportCard(gameId);
    expect((await answer(A, { answer: "yes" })).error).toBeTruthy();
    expect(await answer(A, { answer: "no" })).toMatchObject({ mine: "no", closed: true });
    expect(await answer(A, { answer: "yes", ack: true })).toMatchObject({ mine: "no", closed: true });
    const b = await answer(B, { answer: "yes", ack: true });
    expect(b.closed).toBe(true);
    expect(b.matrixId).toBeUndefined();
  });

  it("re-checks both are still verified adults at the moment of the reveal", async () => {
    const { A, B, gameId } = await pair();
    toReportCard(gameId);
    await answer(A, { answer: "yes", ack: true });
    await adult(ALICE, "minor");
    const b = await answer(B, { answer: "yes", ack: true });
    expect(b.matrixId).toBeUndefined();
    expect(b.closed).toBe(true);
  });

  it("a report closes the exchange, suspends the reported account and blocks the pair", async () => {
    const { A, B, b, gameId } = await pair();
    const ok = A.once<{ ok: boolean }>(E.STRANGER_REPORTED);
    A.emit(E.STRANGER_REPORT, { reason: "made me uncomfortable" });
    expect((await ok).ok).toBe(true);
    toReportCard(gameId);
    await answer(A, { answer: "yes", ack: true });
    const st = await answer(B, { answer: "yes", ack: true });
    expect(st.matrixId).toBeUndefined();
    expect(st.closed).toBe(true);
    const bobSubject = await stranger.age.subjectHash(BOB);
    expect(await repo.stranger.isSuspended(bobSubject)).toBe(true);
    expect(await repo.stranger.isBlocked(await stranger.age.subjectHash(ALICE), bobSubject)).toBe(true);
    // Suspended: Bob can't queue again until it's reviewed.
    expect((await post("/stranger/queue/join", { pass: b, childName: "X" })).status).toBe(403);
  });

  it("admin sees reports (no Matrix ids) and can lift a suspension", async () => {
    const { A } = await pair();
    const ok = A.once(E.STRANGER_REPORTED);
    A.emit(E.STRANGER_REPORT, { reason: "spam" });
    await ok;
    const auth = { Authorization: "Bearer admin-test-token" };
    expect((await fetch(`${origin}/api/admin/stranger/reports`)).status).toBe(401);
    const list = (await (await fetch(`${origin}/api/admin/stranger/reports`, { headers: auth })).json()) as { reports: Array<{ id: string; reason: string }> };
    expect(list.reports).toHaveLength(1);
    expect(list.reports[0].reason).toBe("spam");
    expect(JSON.stringify(list)).not.toMatch(/@alice|@bob/);
    const r = await post(`/admin/stranger/reports/${list.reports[0].id}/resolve`, { action: "lift" }, auth);
    expect(r.status).toBe(200);
    expect(await repo.stranger.isSuspended(await stranger.age.subjectHash(BOB))).toBe(false);
  });

  it("not in an ordinary invite game", async () => {
    const p1 = await client();
    const j = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Ilse" });
    const { gameId } = await j;
    toReportCard(gameId);
    expect((await answer(p1, { answer: "yes", ack: true })).error).toBeTruthy();
    const err = p1.once<{ error: string }>(E.ERROR);
    p1.emit(E.STRANGER_REPORT, { reason: "x" });
    expect((await err).error).toBeTruthy();
  });

  // ---- Security review blockers ----

  it("a report that lands while the reveal is being checked stops the reveal", async () => {
    const { A, B, gameId } = await pair();
    toReportCard(gameId);
    await answer(A, { answer: "yes", ack: true });
    // Each re-check reads, THEN stalls: the report lands after every read
    // the reveal makes, so only a re-check after the last await can catch it.
    const isSuspended = repo.stranger.isSuspended.bind(repo.stranger);
    repo.stranger.isSuspended = async (x: string) => {
      const r = await isSuspended(x);
      await wait(40);
      return r;
    };
    const seen: unknown[] = [];
    A.socket.on(E.HANDLE_STATE, (st) => seen.push(st));
    B.socket.on(E.HANDLE_STATE, (st) => seen.push(st));
    B.emit(E.HANDLE_EXCHANGE, { answer: "yes", ack: true });
    await wait(60);
    const reported = A.once(E.STRANGER_REPORTED);
    A.emit(E.STRANGER_REPORT, { reason: "said something threatening" });
    await reported;
    await wait(200);
    expect(JSON.stringify(seen)).not.toMatch(/@alice|@bob/);
  });

  it("a report back from the reported seat is a counter-report: reviewed, never an automatic suspension", async () => {
    const { A, B } = await pair();
    const first = A.once(E.STRANGER_REPORTED);
    A.emit(E.STRANGER_REPORT, { reason: "harassment" });
    await first;
    const back = B.once<{ ok: boolean }>(E.STRANGER_REPORTED);
    B.emit(E.STRANGER_REPORT, { reason: "they reported me" });
    expect((await back).ok).toBe(true);
    const alice = await stranger.age.subjectHash(ALICE);
    const bob = await stranger.age.subjectHash(BOB);
    expect(await repo.stranger.isSuspended(alice)).toBe(false);
    expect(await repo.stranger.isSuspended(bob)).toBe(true);
    const all = await repo.stranger.listReports(10);
    expect(all.map((r) => [r.reporter === bob ? "bob" : "alice", r.status]).sort()).toEqual([["alice", "open"], ["bob", "counter"]]);
  });

  it("one report per seat per game", async () => {
    const { A } = await pair();
    for (let i = 0; i < 3; i++) {
      const ok = A.once(E.STRANGER_REPORTED);
      A.emit(E.STRANGER_REPORT, { reason: `again ${i}` });
      await ok;
    }
    expect(await repo.stranger.listReports(10)).toHaveLength(1);
  });

  it("lifting one report keeps a suspension other reports still hold; a resolved report can't be resolved again", async () => {
    const { A } = await pair();
    const ok = A.once(E.STRANGER_REPORTED);
    A.emit(E.STRANGER_REPORT, { reason: "first" });
    await ok;
    const bob = await stranger.age.subjectHash(BOB);
    await repo.stranger.addReport({ id: "other-report", gameId: "another-game", reporter: "someone-else", reported: bob, reason: "second", createdAt: Date.now(), status: "open" });
    const auth = { Authorization: "Bearer admin-test-token" };
    const mine = (await repo.stranger.listReports(10)).find((r) => r.id !== "other-report")!;
    const r = await post(`/admin/stranger/reports/${mine.id}/resolve`, { action: "lift" }, auth);
    expect(r.status).toBe(200);
    expect(r.body.suspensionLifted).toBe(false);
    expect(await repo.stranger.isSuspended(bob)).toBe(true);
    expect((await post(`/admin/stranger/reports/${mine.id}/resolve`, { action: "keep" }, auth)).status).toBe(409);
    // The last one standing lifts it.
    const last = await post(`/admin/stranger/reports/other-report/resolve`, { action: "lift" }, auth);
    expect(last.body.suspensionLifted).toBe(true);
    expect(await repo.stranger.isSuspended(bob)).toBe(false);
  });

  it("a counter-report can be upheld by an admin, which suspends then", async () => {
    const { A, B } = await pair();
    let ok = A.once(E.STRANGER_REPORTED);
    A.emit(E.STRANGER_REPORT, { reason: "x" });
    await ok;
    ok = B.once(E.STRANGER_REPORTED);
    B.emit(E.STRANGER_REPORT, { reason: "y" });
    await ok;
    const alice = await stranger.age.subjectHash(ALICE);
    const counter = (await repo.stranger.listReports(10)).find((r) => r.status === "counter")!;
    const auth = { Authorization: "Bearer admin-test-token" };
    expect((await post(`/admin/stranger/reports/${counter.id}/resolve`, { action: "lift" }, auth)).status).toBe(400);
    expect((await post(`/admin/stranger/reports/${counter.id}/resolve`, { action: "keep" }, auth)).status).toBe(200);
    expect(await repo.stranger.isSuspended(alice)).toBe(true);
  });
});
