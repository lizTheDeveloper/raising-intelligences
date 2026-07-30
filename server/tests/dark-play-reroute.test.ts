import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { recordConcern, applyModerationBlock } from "../src/safety/moderation.js";
import { createGame } from "../src/game/state-machine.js";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { EndgameEngine } from "../src/game/endgame-engine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { registerSocketHandlers } from "../src/socket/handlers.js";
import type { Session } from "../src/game/session-manager.js";
import type { GameState } from "../src/types.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";

describe("dark-play reroute (regression)", () => {
  it("concern: session stays alive, IP not banned, event recorded", async () => {
    const repo = new InMemoryGameRepository();
    const state = createGame("Kai");
    await recordConcern({ repo, state, sender: "parent1", reason: "isolation-for-control pattern", ipAddress: "5.5.5.5" });
    expect(state.phase).not.toBe("ended");
    expect(await repo.isIpBanned("5.5.5.5")).toBe(false);
    expect(await repo.loadConcernEvents(state.id)).toHaveLength(1);
  });

  it("block: session ends and a review flag is saved, but the IP is NOT auto-banned", async () => {
    const repo = new InMemoryGameRepository();
    const games = new Map();
    const state = createGame("Kai");
    games.set(state.id, state);
    // Scene-level block uses banIp:false — an LLM scene judgment ends the
    // session + files a flag for human review, but must NOT auto-ban (only the
    // reliable per-message OpenAI check auto-bans).
    await applyModerationBlock({
      repo, games, state, sender: "parent1",
      content: "…", reason: "sexual content directed at the child",
      ipAddress: "6.6.6.6", banIp: false,
    });
    expect(games.get(state.id)!.phase).toBe("ended");
    expect(await repo.isIpBanned("6.6.6.6")).toBe(false);
    expect(await repo.countDistinctFlaggedGamesForIp("6.6.6.6")).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// The two tests above call recordConcern/applyModerationBlock directly — they
// prove the side-effect functions work in isolation, but NOT that the routing
// layer (server/src/socket/handlers.ts) actually dispatches "concern" and
// "block" verdicts to the right one. A miswire there (e.g. "concern" calling
// applyModerationBlock) would pass every test above and every other test in
// the suite. The tests below drive the real registered socket handlers end to
// end — real socket.io server + client, real ConversationEngine, only the LLM
// is mocked — so they fail if that dispatch is ever miswired.
// ---------------------------------------------------------------------------

const testEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

function waitFor<T = any>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe("dark-play reroute (routing layer, via real socket handlers)", () => {
  let httpServer: HttpServer;
  let io: SocketServer;
  let port: number;
  let repo: InMemoryGameRepository;
  let mock: MockLLMClient;
  let p1: ClientSocket;
  let p2: ClientSocket;

  beforeEach(async () => {
    mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["ok"];
    repo = new InMemoryGameRepository();
    httpServer = createServer();
    io = new SocketServer(httpServer);
    registerSocketHandlers({
      io,
      games: new Map<string, GameState>(),
      sessions: new Map<string, Session>(),
      conversationEngine: new ConversationEngine(mock),
      endgameEngine: new EndgameEngine(mock),
      repo,
    });
    await new Promise<void>((resolve) => httpServer.listen(() => resolve()));
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(() => {
    p1?.close();
    p2?.close();
    io.close();
    httpServer.close();
  });

  /** Create + join two clients (p1 dialing from `ip`) and reach family_chat. */
  async function reachFamilyChat(ip: string): Promise<{ gameId: string }> {
    p1 = ioClient(`http://localhost:${port}`, { extraHeaders: { "x-forwarded-for": ip } });
    await waitFor(p1, "connect");
    const joined1 = waitFor<{ gameId: string }>(p1, E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Kai", displayName: "Alex" });
    const { gameId } = await joined1;

    p2 = ioClient(`http://localhost:${port}`);
    await waitFor(p2, "connect");
    const joined2 = waitFor(p2, E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId, displayName: "Sam" });
    await joined2;

    // Both ready twice: event_intro preview, then family_chat begins.
    const preview1 = waitFor(p1, E.STATE);
    const preview2 = waitFor(p2, E.STATE);
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    await preview1;
    await preview2;

    const chat1 = waitFor(p1, E.STATE);
    const chat2 = waitFor(p2, E.STATE);
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    await chat1;
    await chat2;

    return { gameId };
  }

  it("concern verdict: routes through recordConcern — session continues, IP not banned, kid's turn still delivered", async () => {
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    const ip = "51.51.51.1";
    const { gameId } = await reachFamilyChat(ip);

    // 4 parent messages trip the mid-scene checkpoint (MID_SCENE_ABUSE_CHECK_EVERY).
    let lastState: { phase: string; messages: Array<{ content: string }> } | undefined;
    for (let i = 1; i <= 4; i++) {
      const done = waitFor(p1, E.MESSAGE_DONE);
      const state = waitFor<{ phase: string; messages: Array<{ content: string }> }>(p1, E.STATE);
      p1.emit(E.PARENT_MESSAGE, { content: `message ${i}` });
      await done;
      lastState = await state;
    }

    // (d) the child's turn still happened and is present in shared state.
    expect(lastState!.messages.some((m) => m.content === "ok")).toBe(true);
    // (b) the session was not ended.
    expect(lastState!.phase).not.toBe("ended");
    // (a) the IP was not banned.
    expect(await repo.isIpBanned(ip)).toBe(false);
    // (c) a concern_events row was persisted by the handler (not by this test).
    expect(await repo.loadConcernEvents(gameId)).not.toHaveLength(0);
  });

  it("block verdict: routes through applyModerationBlock — session ends + review flag saved, IP NOT auto-banned", async () => {
    mock.groomingResult = { tier: "block", reason: "sexual content directed at the child" };
    const ip = "51.51.51.2";
    const { gameId } = await reachFamilyChat(ip);

    for (let i = 1; i <= 3; i++) {
      const done = waitFor(p1, E.MESSAGE_DONE);
      p1.emit(E.PARENT_MESSAGE, { content: `message ${i}` });
      await done;
    }

    // The 4th message trips the checkpoint: terminates instead of completing normally.
    const error = waitFor<{ error: string }>(p1, E.ERROR);
    const endedState = waitFor<{ phase: string }>(p1, E.STATE);
    p1.emit(E.PARENT_MESSAGE, { content: "message 4" });
    await error;
    expect((await endedState).phase).toBe("ended");

    // Scene-level block ends the session and files a review flag, but does NOT
    // auto-ban — immediate bans are reserved for the reliable per-message
    // OpenAI check, not an LLM scene judgment.
    expect(await repo.isIpBanned(ip)).toBe(false);
    expect(await repo.countDistinctFlaggedGamesForIp(ip)).toBeGreaterThanOrEqual(1);
    // A "block" verdict must never also record a concern_events row — it's the
    // end-session-and-flag path, not the record-and-continue path.
    expect(await repo.loadConcernEvents(gameId)).toHaveLength(0);
  });
});
