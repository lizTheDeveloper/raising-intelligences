import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, TEST_SEED, type TestServer } from "./helpers/test-server.js";
import { TestClient, connect, openFirstScene } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";

/**
 * Deterministic Math.random for the duration of this file.
 *
 * `combineTraits` (game/personality.ts) derives the child's OCEAN scores
 * with `Math.random`, and those scores are interpolated into the
 * personality_seed prompt — which is part of the cassette key (a hash of the
 * full prompt). Unseeded, every run asks the provider for a DIFFERENT seed
 * document, so a recorded entry can never be found on replay. Pinning the
 * PRNG to TEST_SEED makes record and replay build byte-identical prompts.
 * (Only personality.ts draws from Math.random in the server code, so this
 * cannot perturb any other system under test.)
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const REAL_RANDOM = Math.random;

/**
 * Full two-player playthrough over the real socket.io transport: lobby join,
 * the guardian quiz + single ready gate that opens scene 1, a streamed family
 * chat, a private sidebar (with its privacy guarantees), the psychologist
 * debrief, a second event to prove the loop, then epilogue and report card.
 *
 * Everything is the real server — two genuine socket.io clients against the
 * in-process app. Only the model provider is replayed from a seed-keyed
 * cassette. Re-record with: LLM_CACHE_MODE=record LLM_SEED=424242 npm test -w server
 *
 * Flow note (opening reorder, 2026-07-31): the lobby gate no longer generates
 * the first scene — readying takes both parents into the guardian quiz, and
 * scene 1 is built when the personality seed lands (see SUBMIT_PERSONALITY /
 * startFirstScene in socket/handlers.ts). Every subsequent scene advances in
 * ONE ready gate: endDebrief + loadEvent + beginChat inside the same lock,
 * consuming the prefetch started at endChat. State assertions therefore wait
 * on a PREDICATE (family_chat + the expected event) rather than the next
 * STATE, because the gate broadcasts an intermediate generating:true STATE
 * before the scene lands.
 */
describe("E2E: two-player socket playthrough", () => {
  let server: TestServer;
  let p1: TestClient;
  let p2: TestClient;
  let gameId: string;

  beforeAll(async () => {
    Math.random = mulberry32(TEST_SEED);
    server = await createTestServer("multiplayer-playthrough");
    p1 = await connect(server.baseUrl);
    p2 = await connect(server.baseUrl);
  });

  afterAll(async () => {
    Math.random = REAL_RANDOM;
    p1?.close();
    p2?.close();
    // In record mode, drain any fire-and-forget LLM calls still in flight (the
    // endChat scene prefetch) so the cassette is written complete rather than
    // left with a hole that replay then trips over.
    await server?.cassette.waitInFlight();
    await server?.stop();
  });

  /** Both players ready up; resolve with the first STATE matching `predicate`,
   * skipping the intermediate broadcasts (lobby echo, generating:true frames). */
  async function advance(
    predicate: (s: ViewerState) => boolean
  ): Promise<ViewerState> {
    const next = p1.waitFor<ViewerState>(E.STATE, predicate);
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    return next;
  }

  /**
   * Send a parent message and wait until *every* observer has settled. The
   * server broadcasts STATE to each player and then MESSAGE_DONE to the room;
   * because socket.io preserves per-connection order, awaiting an observer's
   * MESSAGE_DONE guarantees its preceding STATE has already been applied — so
   * both players' `lastState` are current when this resolves. Defaults to both
   * players; pass a subset for sidebars where only one should be settling.
   */
  async function say(
    client: TestClient,
    content: string,
    observers: TestClient[] = [p1, p2]
  ): Promise<void> {
    const dones = observers.map((o) => o.once(E.MESSAGE_DONE));
    client.emit(E.PARENT_MESSAGE, { content });
    await Promise.all(dones);
  }

  it("seats both players in the lobby", async () => {
    const joined1 = p1.once<{ gameId: string; slot: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Mateo", displayName: "Ada" });
    const j1 = await joined1;
    gameId = j1.gameId;
    expect(j1.slot).toBe("parent1");

    const joined2 = p2.once<{ slot: string }>(E.JOINED);
    const lobby = p2.waitFor<{ players: unknown[] }>(E.LOBBY, (l) => l.players.length === 2);
    p2.emit(E.JOIN_GAME, { gameId, displayName: "Bo" });
    const j2 = await joined2;
    expect(j2.slot).toBe("parent2");
    expect((await lobby).players.length).toBe(2);
  });

  it("passes the guardian quiz, and one gate opens scene 1 into family chat", async () => {
    // Register the waiter BEFORE the emits so no intermediate STATE can be
    // missed; openFirstScene ready-ups both parents and submits both
    // personalities, which drives seed generation + startFirstScene.
    const scene = openFirstScene(p1, p2);
    const s = await scene;
    expect(s.phase).toBe("family_chat");
    expect(s.currentEvent).not.toBeNull();
    expect(s.currentEvent!.eventNumber).toBe(1);
  });

  it("streams the kid's reply to both players in shared chat", async () => {
    p1.resetStream();
    p2.resetStream();
    await say(p1, "Hey Mateo, what's got you so quiet today?");

    // Both players see the streamed reply, and it lands in shared state.
    expect(p1.kidStream.length).toBeGreaterThan(0);
    expect(p2.kidStream).toBe(p1.kidStream);
    const kidMsg = p1.lastState!.messages.filter((m) => m.sender === "kid");
    expect(kidMsg.length).toBe(1);
    expect(p2.lastState!.messages.length).toBe(p1.lastState!.messages.length);

    await say(p2, "We love you no matter what, you know that?");
    expect(p1.lastState!.messages.filter((m) => m.sender === "kid").length).toBe(2);
  });

  it("keeps a sidebar private to the initiating parent", async () => {
    const sidebarStarted = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "sidebar");
    p1.emit(E.START_SIDEBAR);
    const s = await sidebarStarted;
    expect(s.phase).toBe("sidebar");

    p1.resetStream();
    p2.resetStream();
    const before = p2.lastState!.messages.length;
    await say(p1, "Just between us — are you scared about the move?");

    // Parent 1 receives the streamed reply; parent 2 is fully in the dark.
    expect(p1.kidStream.length).toBeGreaterThan(0);
    expect(p2.kidStream).toBe("");
    expect(p2.lastState!.messages.length).toBe(before);
    // Parent 2's projection must never contain the private exchange.
    const leaked = p2.lastState!.messages.some((m) =>
      m.content.includes("are you scared about the move")
    );
    expect(leaked).toBe(false);

    const ended = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    p1.emit(E.END_SIDEBAR);
    expect((await ended).phase).toBe("family_chat");

    // Parent 2 cannot reopen the same parent's sidebar — it's used up. And only
    // parent1 may speak during parent1's sidebar (already covered above).
    expect(p1.lastState!.sidebarUsed.parent1).toBe(true);
  });

  it("ends the chat, producing a psychologist identity snapshot", async () => {
    // endChat emits a `processing` STATE before the psychologist call returns;
    // wait for the debrief frame, not the next STATE.
    const debrief = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
    p1.emit(E.END_CHAT);
    const d = await debrief;
    expect(d.phase).toBe("debrief");

    const reloaded = await server.memRepo.loadGame(gameId);
    expect(reloaded?.identitySnapshots.length).toBe(1);
  });

  it("loops through a second event after the debrief", async () => {
    // The debrief gate only ends the debrief → event_intro (no scene loaded);
    // the NEXT ready gate, now in event_intro, is the one that loads event 2
    // (consuming the prefetch started at endChat) AND begins the chat in a
    // single lock.
    const intro = await advance((s) => s.phase === "event_intro");
    expect(intro.phase).toBe("event_intro");
    expect(intro.currentEvent).toBeNull();

    const loaded = await advance((s) => s.currentEvent?.eventNumber === 2);
    expect(loaded.phase).toBe("family_chat");
    expect(loaded.currentEvent!.eventNumber).toBe(2);

    await say(p1, "How was your day, kiddo?");
    expect(p1.lastState!.currentEventNumber).toBe(2);
    // The kid answered in event 2 (messages accumulate across events, so
    // scope the count by eventNumber).
    expect(
      p1.lastState!.messages.filter((m) => m.sender === "kid" && m.eventNumber === 2).length
    ).toBe(1);

    const debrief = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
    p1.emit(E.END_CHAT);
    expect((await debrief).phase).toBe("debrief");
  });

  it("generates the epilogue and the final report card", async () => {
    const epilogue = p1.once<{ epilogue: string }>(E.EPILOGUE);
    p1.emit(E.START_EPILOGUE);
    const ep = await epilogue;
    expect(ep.epilogue.length).toBeGreaterThan(0);

    const report = p1.once<{ reportCard: string }>(E.REPORT_CARD_READY);
    p1.emit(E.REPORT_CARD, { epilogue: ep.epilogue });
    const rc = await report;
    expect(rc.reportCard).toContain("Mateo");

    const endgame = await server.memRepo.getEndgame(gameId);
    expect(endgame?.reportCard.length).toBeGreaterThan(0);
  });
});
