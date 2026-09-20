import { describe, it, expect, beforeEach, vi } from "vitest";
import { _resetPoolCacheForTests, _setPoolForTests } from "../src/llm/model-config.js";
import type { PoolEntry } from "../src/llm/model-config.js";
import { ChildSeedClient } from "../src/llm/child-seed-client.js";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMRole } from "../src/llm/model-config.js";
import { TracedLLMClient } from "../src/observability/langfuse.js";
import type { TraceMetadata } from "../src/observability/langfuse.js";

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

describe("kidModel Langfuse metadata", () => {
  beforeEach(() => {
    _resetPoolCacheForTests();
    _setPoolForTests("standard", pool);
  });

  it("withModelOverride stamps kidModel into the returned TracedLLMClient's metadata", () => {
    const mockInner = makeMockRoutingClient();
    const traced = new TracedLLMClient(mockInner, { gameId: "game-lf-1", role: "kid_family_chat" });

    const overridden = traced.withModelOverride("alpha/model-a");

    expect(overridden).toBeInstanceOf(TracedLLMClient);
    expect(overridden).not.toBe(traced);
    // metadata is private; introspect it directly (test-only) rather than
    // relying on a network call to Langfuse to observe it.
    expect((overridden as unknown as { metadata: TraceMetadata }).metadata).toMatchObject({
      gameId: "game-lf-1",
      role: "kid_family_chat",
      kidModel: "alpha/model-a",
    });
    // the original client must be untouched (withModelOverride returns a new instance).
    expect((traced as unknown as { metadata: TraceMetadata }).metadata.kidModel).toBeUndefined();
  });

  it("threads kidModel through the full ChildSeedClient -> TracedLLMClient chain", async () => {
    const mockInner = makeMockRoutingClient();
    const traced = new TracedLLMClient(mockInner, { gameId: "game-lf-2", role: "kid_family_chat" });
    const overrideSpy = vi.spyOn(traced, "withModelOverride");

    const childSeed = new ChildSeedClient(traced, "standard", "game-lf-2");
    await childSeed.streamResponse("sys", [], () => {}, "kid_family_chat");

    // ChildSeedClient must have asked the TracedLLMClient to override its model...
    expect(overrideSpy).toHaveBeenCalledTimes(1);
    const resolvedModel = overrideSpy.mock.calls[0][0];
    expect(["alpha/model-a", "beta/model-b"]).toContain(resolvedModel);

    // ...and the TracedLLMClient it produced must carry that model as kidModel
    // metadata, which is exactly what Langfuse traces from calls on it will report.
    const overriddenClient = overrideSpy.mock.results[0].value as TracedLLMClient;
    expect(overriddenClient).toBeInstanceOf(TracedLLMClient);
    expect(overriddenClient).not.toBe(traced);
    expect((overriddenClient as unknown as { metadata: TraceMetadata }).metadata.kidModel).toBe(
      resolvedModel
    );

    // and the mock's own inner (the thing that finally "sends" the trace)
    // received the same override, proving the chain is unbroken end-to-end.
    expect(mockInner.lastOverride).toBe(resolvedModel);
  });
});
