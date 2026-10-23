/**
 * Solo games: scene 1 must be built after the personality seed exists.
 *
 * POST /game used to queue a next-event prefetch immediately, from a state with
 * `personalitySeed: ""`. /next-event then consumed that prefetch, so scene 1's
 * world-manager call never saw the seed (and a second world-manager call was
 * wasted on a pre-seed scene).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { LLMRole } from "../src/llm/model-config.js";

const SEED_SENTINEL = "SEED-SENTINEL: quick to laugh, slow to trust.";

class RecordingMock extends MockLLMClient {
  worldManagerPrompts: string[] = [];

  override async completeJson<T>(system: string, userMessage: string, role?: LLMRole): Promise<T> {
    if (role === "world_manager") this.worldManagerPrompts.push(`${system}\n${userMessage}`);
    return super.completeJson<T>(system, userMessage, role);
  }

  override async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    if (role === "personality_seed") return SEED_SENTINEL;
    return super.completeResponse(system, userMessage, maxTokens, role, onChunk);
  }
}

describe("solo scene 1 is built after the personality seed", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: RecordingMock;

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new RecordingMock();
    mock.events = Array.from({ length: 6 }, (_, i) => ({
      eventNumber: i + 1,
      age: 4,
      description: `Scenario ${i + 1}.`,
      setting: "Home",
      trigger: "Test",
    }));
    built = buildServer({
      llm: mock,
      repo: new InMemoryGameRepository(),
      enableEviction: false,
      allowedOrigin: "*",
    });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => built.httpServer.close(() => r()));
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("scene 1 world-manager context contains the personality seed", async () => {
    const created = await post("/game", { childName: "Kai", relationshipType: "solo parent" });
    const { gameId } = (await created.json()) as { gameId: string };

    const pr = await post(`/game/${gameId}/personality`, {
      ocean: [3, 3, 3, 3, 3],
      confessional1: "x",
      slot: "parent1",
    });
    expect(((await pr.json()) as { ready: boolean }).ready).toBe(true);

    const ne = await post(`/game/${gameId}/next-event`, {});
    expect(ne.status).toBe(200);

    expect(mock.worldManagerPrompts).toHaveLength(1);
    expect(mock.worldManagerPrompts[0]).toContain(SEED_SENTINEL);
  });
});
