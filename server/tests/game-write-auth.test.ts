import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { TestClient, connect } from "./helpers/socket-client.js";
import type { GameEvent } from "../src/types.js";

/**
 * Every REST route that generates for a game, or advances or changes it,
 * needs the caller's own credential, the same ones that read it (F1):
 * a solo game's secret, a seat's token, or the owner's Matrix sign-in on a
 * kid synced with proof. A game id alone was enough before: anyone holding
 * one could spend LLM calls on someone else's game, overwrite its epilogue or
 * report card, or push it to its next scene. A legacy game's read-only claim
 * reads and never writes.
 */

const ALICE = "@alice:multiversegames.ai";
const TOKENS: Record<string, string> = { "tok-alice": ALICE };

function event(n: number): GameEvent {
  return { eventNumber: n, age: 4, description: `Scenario ${n}.`, setting: "Home", trigger: "Test" };
}

/** Every POST that takes a game id and acts on that game, with a body each would accept. */
const WRITES: Array<[string, unknown]> = [
  ["next-event", {}],
  ["message", { sender: "parent1", content: "hello" }],
  ["end-chat", {}],
  ["end-debrief", {}],
  ["repair", { message: "I'm sorry about earlier." }],
  ["end-consult", {}],
  ["therapy-message", { content: "hello" }],
  ["end-therapy", {}],
  ["end-cps", {}],
  ["personality", { ocean: [3, 3, 3, 3, 3], confessional1: "a", confessional2: "b" }],
  ["portraits/next", {}],
  ["epilogue", {}],
  ["adult-chat", {}],
  ["report-card", { epilogue: "They grew up." }],
];

describe("game writes need the caller's credential", () => {
  let built: BuiltServer;
  let repo: InMemoryGameRepository;
  let mock: MockLLMClient;
  let api: string;
  let origin: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new MockLLMClient();
    mock.events = [event(1), event(2), event(3)];
    repo = new InMemoryGameRepository();
    built = buildServer({
      llm: mock,
      repo,
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
      verifyMatrix: async (t) => (typeof t === "string" ? TOKENS[t] ?? null : null),
    });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
    api = `${origin}/api`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await built.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  async function soloGame(): Promise<{ gameId: string; secret: string }> {
    const res = await post("/game", { childName: "Kai", relationshipType: "solo parent" });
    expect(res.status).toBe(200);
    return (await res.json()) as { gameId: string; secret: string };
  }

  const snapshot = (id: string) => {
    const s = built.games.get(id)!;
    return JSON.stringify({ phase: s.phase, n: s.currentEventNumber, m: s.messages.length, seed: s.personalitySeed, p: s.parentPersonalities, t: s.therapyMessages?.length });
  };

  it("refuses every write on a solo game from a caller holding only its id, and changes nothing", async () => {
    const { gameId } = await soloGame();
    const before = snapshot(gameId);
    const calls = mock.roleCalls.length;
    for (const [route, body] of WRITES) {
      const none = await post(`/game/${gameId}/${route}`, body);
      expect(`${route} ${none.status}`).toBe(`${route} 403`);
      const wrong = await post(`/game/${gameId}/${route}`, body, { "x-game-secret": "0".repeat(64) });
      expect(`${route} ${wrong.status}`).toBe(`${route} 403`);
      const notASeat = await post(`/game/${gameId}/${route}`, body, { "x-player-token": "made-up" });
      expect(`${route} ${notASeat.status}`).toBe(`${route} 403`);
    }
    expect(snapshot(gameId)).toBe(before);
    expect(mock.roleCalls.length).toBe(calls);
  });

  it("lets the solo player who holds the secret play on", async () => {
    const { gameId, secret } = await soloGame();
    const p = await post(`/game/${gameId}/personality`, { ocean: [3, 3, 3, 3, 3], confessional1: "a", confessional2: "b" }, { "x-game-secret": secret });
    expect(p.status).toBe(200);
    const next = await post(`/game/${gameId}/next-event`, {}, { "x-game-secret": secret });
    expect(next.status).toBe(200);
    expect(built.games.get(gameId)!.currentEventNumber).toBe(1);
  });

  it("lets the owner continue on another device with a Matrix sign-in, once the kid was synced with proof", async () => {
    const { gameId, secret } = await soloGame();
    // Unsynced: the sign-in alone opens nothing.
    expect((await post(`/game/${gameId}/next-event`, {}, { "x-matrix-openid": "tok-alice" })).status).toBe(403);
    await post(`/user/${ALICE}/kids`, [{ gameId, childName: "Kai", secret }], { "x-matrix-openid": "tok-alice" });
    await post(`/game/${gameId}/personality`, { ocean: [3, 3, 3, 3, 3], confessional1: "a", confessional2: "b" }, { "x-game-secret": secret });
    expect((await post(`/game/${gameId}/next-event`, {}, { "x-matrix-openid": "tok-alice" })).status).toBe(200);
  });

  it("refuses writes with a legacy game's read-only claim, and on an unclaimed legacy game", async () => {
    const legacy = createGame("Old Kai", "solo parent");
    built.games.set(legacy.id, legacy);
    await repo.saveGame(legacy);
    const before = snapshot(legacy.id);
    for (const [route, body] of WRITES) {
      expect(`${route} ${(await post(`/game/${legacy.id}/${route}`, body)).status}`).toBe(`${route} 403`);
    }
    const { secret } = (await (await post(`/game/${legacy.id}/claim`, {})).json()) as { secret: string };
    for (const [route, body] of WRITES) {
      const res = await post(`/game/${legacy.id}/${route}`, body, { "x-game-secret": secret });
      expect(`${route} ${res.status}`).toBe(`${route} 403`);
    }
    expect(snapshot(legacy.id)).toBe(before);
  });

  it("on a partner game, refuses a caller holding only the id and lets a seat through", async () => {
    const p1 = await connect(origin);
    clients.push(p1);
    const j1 = p1.once<{ gameId: string; playerToken: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Ilse", displayName: "Host" });
    const { gameId, playerToken } = await j1;
    const before = snapshot(gameId);
    for (const [route, body] of WRITES) {
      expect(`${route} ${(await post(`/game/${gameId}/${route}`, body)).status}`).toBe(`${route} 403`);
    }
    expect(snapshot(gameId)).toBe(before);
    // A seat passes the credential check (the route may still refuse the action for its phase).
    const seat = await post(`/game/${gameId}/epilogue`, {}, { "x-player-token": playerToken });
    expect(seat.status).not.toBe(403);
  });

  it("still 404s a game that doesn't exist", async () => {
    expect((await post(`/game/00000000-0000-4000-8000-000000000000/next-event`, {})).status).toBe(404);
  });
});
