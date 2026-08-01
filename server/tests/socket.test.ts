import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { EndgameEngine } from "../src/game/endgame-engine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { registerSocketHandlers } from "../src/socket/handlers.js";
import type { Session } from "../src/game/session-manager.js";
import type { GameState } from "../src/types.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";

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

/**
 * Resolve with the first `event` payload that satisfies `predicate`, ignoring
 * non-matching ones. A plain `once` is racy here: strays (e.g. a portrait
 * generation finishing) can land on the freshly-registered listener, which made
 * this file fail only under the parallel full-suite run.
 */
function waitUntil<T = any>(
  socket: ClientSocket,
  event: string,
  predicate: (payload: T) => boolean,
  timeoutMs = 10_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(payload: T) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

describe("socket multiplayer flow", () => {
  let httpServer: HttpServer;
  let io: SocketServer;
  let port: number;
  let p1: ClientSocket;
  let p2: ClientSocket;

  beforeEach(async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["I'm sorry!"];
    httpServer = createServer();
    io = new SocketServer(httpServer);
    registerSocketHandlers({
      io,
      games: new Map<string, GameState>(),
      sessions: new Map<string, Session>(),
      conversationEngine: new ConversationEngine(mock),
      endgameEngine: new EndgameEngine(mock),
      repo: new InMemoryGameRepository(),
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

  it("runs create → join → ready → message across two clients", async () => {
    p1 = ioClient(`http://localhost:${port}`);
    await waitFor(p1, "connect");

    // P1 creates the game.
    const joined1 = waitFor<{ gameId: string; slot: string }>(p1, E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Luna", displayName: "Alex" });
    const { gameId, slot } = await joined1;
    expect(slot).toBe("parent1");
    expect(gameId).toBeTruthy();

    // P2 joins the same game.
    p2 = ioClient(`http://localhost:${port}`);
    await waitFor(p2, "connect");
    const lobbyAfterJoin = waitFor<{ players: unknown[] }>(p1, E.LOBBY);
    const joined2 = waitFor<{ slot: string }>(p2, E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId, displayName: "Sam" });
    expect((await joined2).slot).toBe("parent2");
    expect((await lobbyAfterJoin).players).toHaveLength(2);

    // One ready gate, then the guardian quiz. (The gate was two separate
    // both-ready rounds; requiring two synchronised rounds across a slow model
    // call stranded real games in event_intro. Since the 2026-07-31 reorder the
    // single remaining round generates nothing either — submitting the
    // personality quiz is what builds scene 1, so the world manager sees the
    // seed and both parents.)
    const chat1 = waitUntil<{ phase: string; currentEvent: { description: string } }>(
      p1,
      E.STATE,
      (s) => s.phase === "family_chat"
    );
    const chat2 = waitUntil<{ phase: string }>(p2, E.STATE, (s) => s.phase === "family_chat");
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: [3, 2, 4, 2, 3], confessional1: "a", confessional2: "b" });
    p2.emit(E.SUBMIT_PERSONALITY, { ocean: [2, 4, 1, 3, 2], confessional1: "c", confessional2: "d" });
    const s1 = await chat1;
    await chat2;
    expect(s1.phase).toBe("family_chat");
    expect(s1.currentEvent.description).toContain("broke a vase");

    // P1 sends a message; both clients see the message_done + updated state.
    // Wait for the state that actually carries the pair, not merely the next one.
    const done = waitFor(p2, E.MESSAGE_DONE);
    const stateAfterMsg = waitUntil<{ messages: unknown[] }>(
      p2,
      E.STATE,
      (s) => s.messages.length >= 2
    );
    p1.emit(E.PARENT_MESSAGE, { content: "It's okay, accidents happen." });
    await done;
    const afterMsg = await stateAfterMsg;
    // parent message + kid reply, both visible to parent2 in shared chat
    expect(afterMsg.messages).toHaveLength(2);
  });
});
