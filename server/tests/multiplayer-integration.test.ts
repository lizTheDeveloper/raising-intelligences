import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";
import { TestClient, connect } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { LobbyState, ViewerState } from "../src/socket/protocol.js";
import { createGame, transition, PARENT_MESSAGE_CAP } from "../src/game/state-machine.js";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { GameEvent } from "../src/types.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Multiplayer instrumentation that does not depend on the model: lobby
 * capacity, the ready gate, slot reclaim on disconnect, isolation between
 * concurrent games, and the parent message cap. These run entirely offline —
 * the few LLM-touching guarantees live in the playthrough spec.
 */
describe("Multiplayer integration", () => {
  let server: TestServer;
  const clients: TestClient[] = [];

  async function client(): Promise<TestClient> {
    const c = await connect(server.baseUrl);
    clients.push(c);
    return c;
  }

  /** Create a fresh game and return its host client + id. */
  async function host(childName = "Kai"): Promise<{ c: TestClient; gameId: string }> {
    const c = await client();
    const joined = c.once<{ gameId: string }>(E.JOINED);
    c.emit(E.CREATE_GAME, { childName });
    const { gameId } = await joined;
    return { c, gameId };
  }

  beforeAll(async () => {
    server = await createTestServer("multiplayer-integration");
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await server.stop();
  });

  it("rejects a third player joining a full game", async () => {
    const { c: p1, gameId } = await host();
    const p2 = await client();
    const j2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await j2;

    const p3 = await client();
    const err = p3.once<{ error: string }>(E.ERROR);
    p3.emit(E.JOIN_GAME, { gameId });
    expect((await err).error).toMatch(/two players/i);
    void p1;
  });

  it("does not advance until both players are ready", async () => {
    const { c: p1, gameId } = await host();
    const p2 = await client();
    const j2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await j2;

    // Only parent1 readies up.
    const lobby = p1.waitFor<LobbyState>(
      E.LOBBY,
      (l) => l.players.find((p) => p.slot === "parent1")!.ready === true
    );
    p1.emit(E.READY, { ready: true });
    const l = await lobby;
    expect(l.players.find((p) => p.slot === "parent1")!.ready).toBe(true);
    expect(l.players.find((p) => p.slot === "parent2")!.ready).toBe(false);

    // Nothing should have triggered the world manager (which, in replay mode,
    // would surface as an error since no cassette entry exists). The event
    // stays unset.
    await delay(150);
    expect(p1.lastError).toBeUndefined();
    expect(p1.lastState?.currentEvent ?? null).toBeNull();
  });

  it("marks player disconnected and allows token-based reconnect", async () => {
    const { c: p1, gameId } = await host();
    const p2 = await client();
    const j2 = p2.once<{ gameId: string; slot: string; playerToken: string }>(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    const { playerToken } = await j2;

    // Parent 1 sees parent 2 become disconnected (not removed).
    const disconnected = p1.waitFor<LobbyState>(
      E.LOBBY,
      (l) => l.players.length === 2 && !l.players.find((p) => p.slot === "parent2")!.connected
    );
    p2.close();
    const lobby = await disconnected;
    expect(lobby.players.length).toBe(2);
    expect(lobby.players.find((p) => p.slot === "parent2")!.connected).toBe(false);

    // A new connection reclaims the same slot using the token.
    const p2b = await client();
    const joined = p2b.once<{ slot: string }>(E.JOINED);
    const state = p2b.waitFor<ViewerState>(E.STATE, (s) => s.id === gameId);
    p2b.emit(E.JOIN_GAME, { gameId, playerToken });
    expect((await joined).slot).toBe("parent2");
    expect((await state).id).toBe(gameId);
  });

  it("isolates two concurrent games", async () => {
    const a = await host("Alice");
    const b = await host("Bob");
    expect(a.gameId).not.toBe(b.gameId);

    // A joiner for game A must not receive game B's state.
    const joiner = await client();
    const joined = joiner.once<{ gameId: string }>(E.JOINED);
    const state = joiner.waitFor<ViewerState>(E.STATE, (s) => s.id === a.gameId);
    joiner.emit(E.JOIN_GAME, { gameId: a.gameId });
    await joined;
    expect((await state).childName).toBe("Alice");
  });

  it("rejects actions from a socket that never joined a game", async () => {
    const stranger = await client();
    const err = stranger.once<{ error: string }>(E.ERROR);
    stranger.emit(E.PARENT_MESSAGE, { content: "hello?" });
    expect((await err).error).toMatch(/not in a game/i);
  });

  it("enforces the parent message cap in the engine + state machine", async () => {
    const mock = new MockLLMClient();
    const engine = new ConversationEngine(mock);
    const event: GameEvent = {
      eventNumber: 1,
      age: 5,
      description: "A scripted scene.",
      setting: "Home",
      trigger: "Test",
    };

    let state = createGame("Kai");
    state = transition(state, { type: "START_EVENT", event });

    // Drive the chat right up to the cap through the real engine.
    for (let i = 0; i < PARENT_MESSAGE_CAP; i++) {
      const sender = i % 2 === 0 ? "parent1" : "parent2";
      const result = await engine.handleParentMessage(state, sender, `msg ${i}`);
      state = result.state;
    }

    expect(engine.isAtMessageCap(state)).toBe(true);
    expect(engine.getMessageCapRemaining(state)).toBe(0);
    // One more parent message is an illegal transition.
    expect(() =>
      transition(state, { type: "PARENT_MESSAGE", sender: "parent1", content: "over" })
    ).toThrow(/Invalid transition/);
  });
});
