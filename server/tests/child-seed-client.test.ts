import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChildSeedClient } from "../src/llm/child-seed-client.js";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMRole } from "../src/llm/model-config.js";
import { _resetPoolCacheForTests, _setPoolForTests } from "../src/llm/model-config.js";
import type { PoolEntry } from "../src/llm/model-config.js";

function makeMockClient(): LLMClient & { lastRole?: LLMRole } {
  const mock: LLMClient & { lastRole?: LLMRole } = {
    async streamResponse(_sys, _msgs, onChunk, role) {
      mock.lastRole = role;
      onChunk("hello");
      return "hello";
    },
    async completeResponse(_sys, _msg, _max, role) {
      mock.lastRole = role;
      return "response";
    },
    async completeJson<T>(_sys: string, _msg: string, role?: LLMRole) {
      mock.lastRole = role;
      return {} as T;
    },
  };
  return mock;
}

const pool: PoolEntry[] = [
  { slug: "test-model-a", freeSlug: null, weight: 1 },
  { slug: "test-model-b", freeSlug: null, weight: 1 },
];

describe("ChildSeedClient", () => {
  beforeEach(() => {
    _resetPoolCacheForTests();
    _setPoolForTests("standard", pool);
  });

  it("delegates non-kid roles directly to inner client", async () => {
    const inner = makeMockClient();
    const client = new ChildSeedClient(inner, "standard", "game-123");
    await client.completeResponse("sys", "msg", 500, "psychologist");
    expect(inner.lastRole).toBe("psychologist");
  });

  it("delegates non-kid roles without modifying them", async () => {
    const inner = makeMockClient();
    const client = new ChildSeedClient(inner, "standard", "game-123");
    await client.completeResponse("sys", "msg", 500, "world_manager");
    expect(inner.lastRole).toBe("world_manager");
  });

  it("resolves a kid model for kid_family_chat role", async () => {
    const inner = makeMockClient();
    const client = new ChildSeedClient(inner, "standard", "game-123");
    await client.streamResponse("sys", [], () => {}, "kid_family_chat");
    // The inner client should have been called — the model override happens
    // at a level above the LLMClient interface (in the routing client).
    // ChildSeedClient's job is to expose the resolved kidModel.
    expect(client.kidModel).toBeTruthy();
    expect(["test-model-a", "test-model-b"]).toContain(client.kidModel);
  });

  it("resolves the same model for all kid roles on the same gameId", async () => {
    const inner = makeMockClient();
    const client = new ChildSeedClient(inner, "standard", "game-sticky");
    await client.streamResponse("sys", [], () => {}, "kid_family_chat");
    const model1 = client.kidModel;
    await client.completeResponse("sys", "msg", 500, "kid_sidebar");
    const model2 = client.kidModel;
    await client.completeResponse("sys", "msg", 500, "kid_adult_chat");
    const model3 = client.kidModel;
    expect(model1).toBe(model2);
    expect(model2).toBe(model3);
  });
});
