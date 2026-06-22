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

    // Both ready up → first event starts, both clients receive family_chat state.
    const state1 = waitFor<{ phase: string; currentEvent: { description: string } }>(p1, E.STATE);
    const state2 = waitFor<{ phase: string }>(p2, E.STATE); // drain p2's ready-phase state too
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    const s1 = await state1;
    await state2;
    expect(s1.phase).toBe("family_chat");
    expect(s1.currentEvent.description).toContain("broke a vase");

    // P1 sends a message; both clients see the message_done + updated state.
    const done = waitFor(p2, E.MESSAGE_DONE);
    const stateAfterMsg = waitFor<{ messages: unknown[] }>(p2, E.STATE);
    p1.emit(E.PARENT_MESSAGE, { content: "It's okay, accidents happen." });
    await done;
    const afterMsg = await stateAfterMsg;
    // parent message + kid reply, both visible to parent2 in shared chat
    expect(afterMsg.messages).toHaveLength(2);
  });
});
