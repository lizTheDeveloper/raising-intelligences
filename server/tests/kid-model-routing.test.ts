import { describe, it, expect, beforeEach } from "vitest";
import { _resetPoolCacheForTests, _setPoolForTests } from "../src/llm/model-config.js";
import type { PoolEntry } from "../src/llm/model-config.js";
import { ChildSeedClient } from "../src/llm/child-seed-client.js";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMRole } from "../src/llm/model-config.js";

const pool: PoolEntry[] = [
  { slug: "alpha/model-a", freeSlug: null, weight: 1 },
  { slug: "beta/model-b", freeSlug: null, weight: 1 },
];

/** A mock that records which model override it received. */
function makeMockRoutingClient(): LLMClient & {
  lastOverride?: string;
  withModelOverride: (model: string) => LLMClient;
} {
  const mock: LLMClient & {
    lastOverride?: string;
    withModelOverride: (model: string) => LLMClient;
  } = {
    async streamResponse(_s, _m, onChunk, _r) { onChunk("ok"); return "ok"; },
    async completeResponse() { return "ok"; },
    async completeJson<T>() { return {} as T; },
    withModelOverride(model: string) {
      mock.lastOverride = model;
      return mock;
    },
  };
  return mock;
}

describe("kid model routing integration", () => {
  beforeEach(() => {
    _resetPoolCacheForTests();
    _setPoolForTests("standard", pool);
  });

  it("passes model override for kid_family_chat calls", async () => {
    const inner = makeMockRoutingClient();
    const client = new ChildSeedClient(inner, "standard", "game-route-1");
    await client.streamResponse("sys", [], () => {}, "kid_family_chat");
    expect(inner.lastOverride).toBeTruthy();
    expect(["alpha/model-a", "beta/model-b"]).toContain(inner.lastOverride);
  });

  it("does NOT pass model override for psychologist calls", async () => {
    const inner = makeMockRoutingClient();
    const client = new ChildSeedClient(inner, "standard", "game-route-2");
    await client.completeResponse("sys", "msg", 500, "psychologist");
    expect(inner.lastOverride).toBeUndefined();
  });
});
