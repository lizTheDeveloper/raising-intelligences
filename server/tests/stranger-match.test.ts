import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { AgeVerification } from "../src/stranger/identity.js";
import { StrangerPasses } from "../src/stranger/matrix-identity.js";
import { StrangerService } from "../src/stranger/service.js";
import type { StrangerConfig } from "../src/stranger/config.js";
import { PartnerPayments } from "../src/payments/partner-payments.js";
import { TestClient, connect, OCEAN_P1, OCEAN_P2 } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import type { GameEvent } from "../src/types.js";
import { FakeIdentity, strangerConfig } from "./helpers/fake-identity.js";
import { FakeCheckout, paywallConfig } from "./helpers/fake-stripe.js";

/**
 * Stranger mode, matching to the first scene: who gets matched, who can sit
 * in a stranger game (only the two verified adults it was made for), what
 * happens when one doesn't come, and who pays.
 */

const ALICE = "@alice:multiversegames.ai";
const BOB = "@bob:multiversegames.ai";
const CAROL = "@carol:multiversegames.ai";

function event(n: number): GameEvent {
  return { eventNumber: n, age: 3, description: `Scenario ${n}.`, setting: "Home", trigger: "Test" };
}

describe("stranger matching", () => {
  let built: BuiltServer;
  let origin: string;
  let cfg: StrangerConfig;
  let stranger: StrangerService;
  let repo: InMemoryGameRepository;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    cfg = strangerConfig({ joinWindowMs: 60_000 });
    repo = new InMemoryGameRepository();
    mock = new MockLLMClient();
    mock.events = [event(1), event(2)];
    await boot();
  });

  let mock: MockLLMClient;
  /** (Re)start the server on the same repository — a restart loses everything in memory. */
  async function boot() {
    stranger = new StrangerService({
      config: () => cfg,
      passes: new StrangerPasses(),
      age: new AgeVerification({ store: repo.stranger, api: new FakeIdentity(), config: () => cfg, childSafety: repo.childSafety, pepper: "k".repeat(64) }),
      verifyMatrix: async () => null,
      store: repo.stranger,
    });
    built = buildServer({
      llm: mock,
      repo,
      adminQueries: new InMemoryAdminQueries(),
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
      stranger,
      payments: new PartnerPayments({ store: repo.partnerPayments, config: () => paywallConfig(), checkout: new FakeCheckout() }),
    });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await built.close();
  });

  async function adult(mxid: string, outcome: "adult" | "minor" = "adult"): Promise<string> {
    const subject = await stranger.age.subjectHash(mxid);
    await repo.stranger.setVerification({ subject, outcome, livemode: true, verifiedAt: Date.now(), sessionId: `vs_${mxid}` });
    return stranger.passes.issue(mxid, "tea-party");
  }

  async function post(path: string, body: unknown) {
    const res = await fetch(`${origin}/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  const queue = (pass: string, childName = "Wren", displayName = "Sam") =>
    post("/stranger/queue/join", { pass, childName, displayName });
  const poll = (pass: string) => post("/stranger/queue/poll", { pass });

  async function client(): Promise<TestClient> {
    const c = await connect(origin);
    clients.push(c);
    return c;
  }

  async function sit(pass: string, m: Record<string, unknown>) {
    const c = await client();
    const joined = c.once<{ slot: string }>(E.JOINED);
    c.emit(E.JOIN_GAME, { gameId: m.gameId, playerToken: m.playerToken, strangerPass: pass });
    return { c, joined: await joined };
  }

  async function refusedJoin(payload: Record<string, unknown>): Promise<string> {
    const c = await client();
    const err = c.once<{ error: string }>(E.ERROR);
    c.emit(E.JOIN_GAME, payload);
    return (await err).error;
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("only verified adults can queue, once each", async () => {
    const stranger_ = stranger.passes.issue("@nobody:multiversegames.ai", "tea-party");
    expect((await queue(stranger_)).status).toBe(403);
    const kid = await adult("@kid:multiversegames.ai", "minor");
    expect((await queue(kid)).status).toBe(401); // a minor's pass is retired outright
    const a = await adult(ALICE);
    expect((await queue(a)).status).toBe(200);
    expect((await queue(a)).status).toBe(200);
    expect((await poll(a)).body).toMatchObject({ status: "waiting", count: 1 });
  });

  it("pairs the first two; the first queued hosts, names the child, sits as parent1", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a, "Wren", "Ash");
    await queue(b, "Juniper", "Bea");
    const ma = (await poll(a)).body;
    const mb = (await poll(b)).body;
    expect(ma).toMatchObject({ status: "matched", slot: "parent1" });
    expect(mb).toMatchObject({ status: "matched", slot: "parent2", gameId: ma.gameId });
    expect(ma.playerToken).not.toBe(mb.playerToken);
    const state = built.games.get(ma.gameId as string)!;
    expect(state.childName).toBe("Wren");
    expect(state.relationshipType).toBe("co-parents who were never together");
  });

  it("only the two matched adults can sit in a stranger game", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    const c = await adult(CAROL);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    const mb = (await poll(b)).body;
    const gameId = ma.gameId;
    // A plain invite-style join, with no seat token.
    expect(await refusedJoin({ gameId })).toMatch(/private/);
    // Bob's seat token, presented by Carol.
    expect(await refusedJoin({ gameId, playerToken: mb.playerToken, strangerPass: c })).toMatch(/private/);
    // Bob's seat token with no pass at all.
    expect(await refusedJoin({ gameId, playerToken: mb.playerToken })).toMatch(/private/);
    const seatA = await sit(a, ma);
    expect(seatA.joined.slot).toBe("parent1");
    const seatB = await sit(b, mb);
    expect(seatB.joined.slot).toBe("parent2");
    // Bob drops; Carol can't reclaim the empty seat.
    seatB.c.close();
    await wait(50);
    expect(await refusedJoin({ gameId, displayName: "Carol", strangerPass: c })).toMatch(/private/);
    // No handoff codes in a stranger game.
    const err = seatA.c.once<{ error: string }>(E.ERROR);
    seatA.c.emit(E.REQUEST_HANDOFF);
    expect((await err).error).toMatch(/stranger/i);
    // Bob comes back on his own seat.
    expect((await sit(b, mb)).joined.slot).toBe("parent2");
  });

  it("a seat stays bound to its adult: a later minor result shuts it", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const mb = (await poll(b)).body;
    await adult(BOB, "minor");
    expect(await refusedJoin({ gameId: mb.gameId, playerToken: mb.playerToken, strangerPass: b })).toMatch(/private/);
  });

  it("with the paywall on, the host (first queued) is the one asked to pay", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    const mb = (await poll(b)).body;
    const A = await sit(a, ma);
    const B = await sit(b, mb);
    const dueA = A.c.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    const dueB = B.c.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    A.c.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    B.c.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P2, confessional1: "b", confessional2: "" });
    expect((await dueA).payment?.youPay).toBe(true);
    expect((await dueB).payment?.youPay).toBe(false);
    expect((await dueA).strangerRun).toBe(true);
  });

  it("a no-show: the one who came is told, can requeue at their old place, and nobody is charged", async () => {
    cfg = strangerConfig({ joinWindowMs: 1500 });
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    const mb = (await poll(b)).body;
    const A = await sit(a, ma);
    const noShow = A.c.once(E.STRANGER_NO_SHOW);
    await noShow;
    expect(built.sessions.get(ma.gameId as string)?.players).toHaveLength(1);
    expect(await repo.partnerPayments.get(ma.gameId as string)).toBeNull();
    // Bob, late, can't sit down any more; his match is gone.
    expect(await refusedJoin({ gameId: mb.gameId, playerToken: mb.playerToken, strangerPass: b })).toMatch(/private/);
    expect((await poll(b)).body).toMatchObject({ status: "none" });
    // Carol queued meanwhile; Alice requeues ahead of her and is matched with her.
    const c = await adult(CAROL);
    await queue(c);
    expect((await post("/stranger/queue/requeue", { pass: a, gameId: ma.gameId })).status).toBe(200);
    const again = (await poll(a)).body;
    expect(again).toMatchObject({ status: "matched", slot: "parent1" });
    expect((await poll(c)).body).toMatchObject({ status: "matched", slot: "parent2" });
  });

  it("nobody came: the game is discarded", async () => {
    cfg = strangerConfig({ joinWindowMs: 1500 });
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    await wait(2000);
    expect(built.games.has(ma.gameId as string)).toBe(false);
    expect((await poll(a)).body).toMatchObject({ status: "none" });
  });

  it("admission is re-checked at the moment of matching", async () => {
    const a = await adult(ALICE);
    await queue(a);
    await adult(ALICE, "minor");
    const b = await adult(BOB);
    await queue(b);
    expect((await poll(b)).body).toMatchObject({ status: "waiting", count: 1 });
  });

  it("a blocked pair is never matched", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await repo.stranger.addBlock(await stranger.age.subjectHash(ALICE), await stranger.age.subjectHash(BOB));
    await queue(a);
    await queue(b);
    expect((await poll(a)).body).toMatchObject({ status: "waiting", count: 2 });
  });

  it("off: the queue doesn't exist", async () => {
    const a = await adult(ALICE);
    cfg = strangerConfig({ mode: "off" });
    expect((await queue(a)).status).not.toBe(200);
  });

  it("once both have arrived the match is released: later, each can queue again", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    const mb = (await poll(b)).body;
    await sit(a, ma);
    await sit(b, mb);
    expect((await poll(a)).body).toMatchObject({ status: "none" });
    await queue(a);
    expect((await poll(a)).body).toMatchObject({ status: "waiting", count: 1 });
  });

  it("a reserved seat is no seat until its adult arrives; REST can't act in a stranger game", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    const mb = (await poll(b)).body;
    expect(built.sessions.get(ma.gameId as string)?.players ?? []).toHaveLength(0);
    await sit(a, ma);
    expect(built.sessions.get(ma.gameId as string)?.players).toHaveLength(1);
    // Bob's reserved token, by REST, without ever joining.
    const r = await post(`/game/${ma.gameId}/personality`, { ocean: OCEAN_P2, confessional1: "x", slot: "parent2", playerToken: mb.playerToken });
    expect(r.status).toBe(403);
    expect((await post(`/game/${ma.gameId}/next-event`, {})).status).toBe(403);
    expect(await repo.partnerPayments.get(ma.gameId as string)).toBeNull();
  });

  it("a discarded game stays shut, even to its own host", async () => {
    cfg = strangerConfig({ joinWindowMs: 1500 });
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    const A = await sit(a, ma);
    await A.c.once(E.STRANGER_NO_SHOW);
    expect((await post("/stranger/queue/requeue", { pass: a, gameId: ma.gameId })).status).toBe(200);
    expect(await refusedJoin({ gameId: ma.gameId, playerToken: ma.playerToken, strangerPass: a })).toMatch(/private/);
  });

  it("after a restart, a host whose match never arrived is told, and can requeue", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    const A = await sit(a, ma);
    A.c.close();
    clients.splice(0);
    await built.close();
    await boot();
    const a2 = stranger.passes.issue(ALICE, "tea-party");
    const c = await client();
    const told = c.once(E.STRANGER_NO_SHOW);
    c.emit(E.JOIN_GAME, { gameId: ma.gameId, playerToken: ma.playerToken, strangerPass: a2 });
    await told;
    expect((await post("/stranger/queue/requeue", { pass: a2, gameId: ma.gameId })).status).toBe(200);
    expect((await poll(a2)).body).toMatchObject({ status: "waiting" });
  });

  it("queueing twice at once is still one place in the queue", async () => {
    const a = await adult(ALICE);
    await Promise.all([queue(a), queue(a), queue(a)]);
    expect((await poll(a)).body).toMatchObject({ status: "waiting", count: 1 });
  });

  it("someone who stops polling leaves the queue (a closed tab is never matched)", async () => {
    cfg = strangerConfig({ joinWindowMs: 60_000, queueIdleMs: 1500 });
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await wait(1800);
    await queue(b);
    expect((await poll(b)).body).toMatchObject({ status: "waiting", count: 1 });
  });

  it("a seated stranger later found to be a minor is put out at their next action", async () => {
    const a = await adult(ALICE);
    const b = await adult(BOB);
    await queue(a);
    await queue(b);
    const ma = (await poll(a)).body;
    const mb = (await poll(b)).body;
    const A = await sit(a, ma);
    await sit(b, mb);
    await adult(ALICE, "minor");
    const gone = new Promise<void>((r) => A.c.socket.once("disconnect", () => r()));
    A.c.emit(E.READY, { ready: true });
    await gone;
  });
});
