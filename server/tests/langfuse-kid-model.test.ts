import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture what TracedLLMClient reports to Langfuse without a network call.
const generations: Array<Record<string, unknown>> = [];
vi.mock("langfuse", () => ({
  Langfuse: class {
    trace() {
      return {
        generation(args: Record<string, unknown>) {
          generations.push(args);
          return { end() {} };
        },
      };
    }
  },
}));

import { _resetPoolCacheForTests, _setPoolForTests, selectModel } from "../src/llm/model-config.js";
import type { LLMClient } from "../src/llm/client.js";
import { ChildSeedClient } from "../src/llm/child-seed-client.js";

const pool = [{ slug: "alpha/model-a", freeSlug: null, weight: 1 }];

function makeInner(): LLMClient & { withModelOverride: (model: string) => LLMClient } {
  const inner = {
    async streamResponse(_s: string, _m: unknown, onChunk: (c: string) => void) { onChunk("ok"); return "ok"; },
    async completeResponse() { return "ok"; },
    async completeJson<T>() { return {} as T; },
    withModelOverride() { return inner; },
  };
  return inner;
}

// Live (2026-09-24): every kid_family_chat generation since the voice rotation was
// logged as the role default (deepseek) while the request actually went to the
// rotated model in metadata.kidModel. Langfuse prices generations from `model`,
// so costs were wrong too.
describe("Langfuse generation model for rotated kid voices", () => {
  beforeEach(() => {
    generations.length = 0;
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    vi.resetModules();
    _resetPoolCacheForTests();
    _setPoolForTests("standard", pool);
  });
  afterEach(() => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
  });

  it("logs the rotated kid model, not the role default, for a kid chat", async () => {
    const { TracedLLMClient } = await import("../src/observability/langfuse.js");
    const traced = new TracedLLMClient(makeInner(), { gameId: "g1" }, "standard");
    const child = new ChildSeedClient(traced, "standard", "g1");
    await child.streamResponse("sys", [], () => {}, "kid_family_chat");

    expect(generations).toHaveLength(1);
    expect(generations[0].model).toBe("alpha/model-a");
    expect((generations[0].metadata as Record<string, unknown>).kidModel).toBe("alpha/model-a");
  });

  it("still logs the role default for roles that are not rotated", async () => {
    const { TracedLLMClient } = await import("../src/observability/langfuse.js");
    const traced = new TracedLLMClient(makeInner(), { gameId: "g2" }, "standard");
    const child = new ChildSeedClient(traced, "standard", "g2");
    await child.completeResponse("sys", "msg", 500, "psychologist");

    expect(generations).toHaveLength(1);
    expect(generations[0].model).toBe(selectModel("psychologist", "standard"));
  });
});
