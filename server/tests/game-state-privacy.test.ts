// #139 — GET /game/:id/state must never leak parentPersonalities (OCEAN
// scores + both parents' confessional text). The projection dropped seven
// server-only fields but omitted parentPersonalities, so it rode along on
// `...publicState` to any caller who knew the gameId.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";
import type { GameState } from "../src/types.js";

describe("GET /game/:id/state — parentPersonalities is never serialized", () => {
  let built: BuiltServer;
  let baseUrl: string;

  beforeAll(async () => {
    const mock = new MockLLMClient();
    const repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await built.close();
  });

  it("strips parentPersonalities (OCEAN + confessionals) from the response", async () => {
    const base = createGame("Wren", "solo parent");
    const state: GameState = {
      ...base,
      parentPersonalities: {
        parent1: {
          ocean: [3, 2, 4, 1, 2],
          confessional1: "The most evil thing I did as a kid was...",
          confessional2: "One thing I never told my parents is...",
        },
        parent2: {
          ocean: [1, 3, 2, 4, 3],
          confessional1: "Something I've never admitted before...",
          confessional2: "A secret I've carried for years...",
        },
      },
    };
    built.games.set(state.id, state);

    const res = await fetch(`${baseUrl}/api/game/${state.id}/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("parentPersonalities");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("evil thing I did as a kid");
    expect(raw).not.toContain("never told my parents");
    expect(raw).not.toContain("never admitted before");
    expect(raw).not.toContain("secret I've carried");
  });
});
