import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { TestClient, connect } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import type { GameEvent } from "../src/types.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockEvent(n: number): GameEvent {
  return {
    eventNumber: n,
    age: 3,
    description: `Scenario ${n}.`,
    setting: "Home",
    trigger: "Test",
  };
}

/**
 * Regression guard for the multiplayer READY race (playtest 2026-07-23):
 * duplicate/concurrent READY events while a scenario is still generating must
 * NOT each fire their own event generation. The handler is serialized through
 * the per-game lock and clears the ready flags before the (long) generation
 * await, so exactly one scenario is produced per ready gate.
 *
 * Probe: MockLLMClient.completeJson shifts one preloaded event per world-manager
 * call. We preload two. A correct single-flight advance consumes exactly one,
 * leaving one behind. The old code consumed both (and the extra scenario
 * clobbered the first — the "rapidly switching scenarios" bug).
 */
describe("Multiplayer READY race", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new MockLLMClient();
    built = buildServer({
      llm: mock,
      repo: new InMemoryGameRepository(),
      adminQueries: new InMemoryAdminQueries(),
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
    });
    await new Promise<void>((resolve) => {
      built.httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await built.close();
  });

  async function client(): Promise<TestClient> {
    const c = await connect(baseUrl);
    clients.push(c);
    return c;
  }

  it("generates exactly one scenario when both players spam 'ready'", async () => {
    // Two events available; a single-flight advance must consume only one.
    mock.events = [mockEvent(1), mockEvent(2)];

    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Kai" });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await joined2;

    const loaded = p1.waitFor<ViewerState>(E.STATE, (s) => s.currentEvent != null);

    // Both players ready — and each fires several extra READYs in the same tick,
    // exactly the double/triple-click the playtest hit.
    for (let i = 0; i < 3; i++) {
      p1.emit(E.READY, { ready: true });
      p2.emit(E.READY, { ready: true });
    }

    const state = await loaded;
    expect(state.currentEvent).not.toBeNull();

    // Let any erroneous second generation settle before asserting.
    await delay(250);

    // Exactly one event consumed → one scenario generated. (Broken code left 0.)
    expect(mock.events.length).toBe(1);
    expect(p1.lastError).toBeUndefined();
    expect(p2.lastError).toBeUndefined();
  });
});
