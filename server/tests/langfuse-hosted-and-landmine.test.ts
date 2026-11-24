import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture what TracedLLMClient reports to Langfuse without a network call.
const traces: Array<Record<string, unknown>> = [];
const generations: Array<Record<string, unknown>> = [];
vi.mock("langfuse", () => ({
  Langfuse: class {
    trace(args: Record<string, unknown>) {
      traces.push(args);
      return {
        generation(g: Record<string, unknown>) {
          generations.push(g);
          return { end() {} };
        },
      };
    }
  },
}));

import type { LLMClient } from "../src/llm/client.js";
import { createGame } from "../src/game/state-machine.js";
import { buildWorldManagerContext } from "../src/game/context-assembler.js";

const SENTINEL = "my brother locked me in the cellar every winter";

function inner(): LLMClient {
  return {
    async streamResponse(_s: string, _m: unknown, onChunk: (c: string) => void) { onChunk("ok"); return "ok"; },
    async completeResponse() { return "ok"; },
    async completeJson<T>() { return {} as T; },
  } as unknown as LLMClient;
}

/** A game whose next scene is built around a parent's confessional (the "pressure point"). */
function gameWithLandmine() {
  const s = createGame("Wren", "co-parents");
  s.parentPersonalities = {
    parent1: { confessional1: SENTINEL, confessional2: SENTINEL } as never,
  } as never;
  // Landmines fire at seeded slots only: move to the scene before the first one.
  for (let n = 0; n < s.totalEvents; n++) {
    s.currentEventNumber = n;
    if (buildWorldManagerContext(s).system.includes(SENTINEL)) return s;
  }
  throw new Error("no landmine slot in this game");
}

describe("Langfuse: hosted games and the world manager's confessional", () => {
  beforeEach(() => {
    traces.length = 0;
    generations.length = 0;
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_HOST = "https://langfuse.example.internal";
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_HOST;
  });

  it("the fixture really does put the confessional in the world-manager prompt", () => {
    const ctx = buildWorldManagerContext(gameWithLandmine());
    expect(ctx.system).toContain(SENTINEL);
  });

  it("a world_manager trace never carries the confessional (every call shape)", async () => {
    const { TracedLLMClient } = await import("../src/observability/langfuse.js");
    const ctx = buildWorldManagerContext(gameWithLandmine());
    const traced = new TracedLLMClient(inner(), { gameId: "g1" });
    await traced.completeJson(ctx.system, ctx.userMessage, "world_manager");
    await traced.completeResponse(ctx.system, ctx.userMessage, "world_manager");
    await traced.streamResponse(ctx.system, [{ role: "user", content: ctx.userMessage }], () => {}, "world_manager");
    expect(generations).toHaveLength(3);
    for (const g of generations) {
      const text = JSON.stringify(g.input);
      expect(text).not.toContain("cellar");
      expect(text).toContain("[redacted");
      // The rest of the prompt is still there to debug with.
      expect(text).toContain("Generate the next event");
    }
  });

  it("fails closed: a pressure point with no closing line is redacted to the end", async () => {
    const { TracedLLMClient } = await import("../src/observability/langfuse.js");
    const ctx = buildWorldManagerContext(gameWithLandmine());
    const cut = ctx.system.slice(0, ctx.system.indexOf(SENTINEL) + SENTINEL.length + 5);
    const traced = new TracedLLMClient(inner(), { gameId: "g1" });
    await traced.completeJson(cut, "go", "world_manager");
    expect(JSON.stringify(generations[0].input)).not.toContain("cellar");
  });

  it("traces of a game at a host-tools event get hosted_no_analysis; others don't", async () => {
    const { TracedLLMClient } = await import("../src/observability/langfuse.js");
    const { markGameHosted, HOSTED_NO_ANALYSIS_TAG } = await import("../src/observability/hosted-analysis.js");
    markGameHosted("g-hosted");
    await new TracedLLMClient(inner(), { gameId: "g-hosted" }).completeResponse("s", "u", "kid");
    await new TracedLLMClient(inner(), { gameId: "g-plain" }).completeResponse("s", "u", "kid");
    expect(traces[0].tags).toContain(HOSTED_NO_ANALYSIS_TAG);
    expect(traces[1].tags).not.toContain(HOSTED_NO_ANALYSIS_TAG);
  });
});
