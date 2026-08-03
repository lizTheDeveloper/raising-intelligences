/**
 * Regression: the gender call starved itself of tokens.
 *
 * Production, 2026-08-03, child name "Theo" on deepseek-v4-flash: three
 * attempts logged outputTokens 11/10/10 — pinned at a `max_tokens: 10` cap —
 * and each returned `content: null`, which the routing client raises as
 * "Unexpected response from openrouter". That is not a timeout, so withRetry
 * spent all three attempts on it and every one failed the same way. The child
 * was then silently "nonbinary" for the entire playthrough: portraits,
 * pronouns and narration all follow this one value.
 *
 * These tests pin the two things that made it unrecoverable — too small a
 * budget, and a parse that only accepted a bare one-word reply.
 */
import { describe, it, expect } from "vitest";
import { inferGender } from "../src/game/personality.js";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMRole } from "../src/llm/model-config.js";

/**
 * Stands in for a reasoning-capable model behind an OpenAI-compatible API:
 * it spends `reasoningTokens` before answering, and when the cap cannot cover
 * that it returns no content at all — which the routing client turns into
 * "Unexpected response from openrouter", exactly as production did.
 */
function starvingModel(opts: {
  reasoningTokens: number;
  answer: string;
  seen: { maxTokens?: number; calls: number };
}): LLMClient {
  return {
    async completeResponse(
      _system: string,
      _userMessage: string,
      maxTokens?: number,
      _role?: LLMRole,
    ): Promise<string> {
      opts.seen.maxTokens = maxTokens;
      opts.seen.calls++;
      if ((maxTokens ?? Infinity) <= opts.reasoningTokens) {
        throw new Error("Unexpected response from openrouter");
      }
      return opts.answer;
    },
  } as unknown as LLMClient;
}

describe("inferGender token budget", () => {
  it("survives a model that spends tokens reasoning before it answers", async () => {
    // 10 reasoning tokens is precisely what production burned.
    const seen = { calls: 0 } as { maxTokens?: number; calls: number };
    const llm = starvingModel({ reasoningTokens: 10, answer: "boy", seen });

    const result = await inferGender(llm, "Theo");

    expect(
      result,
      `starved the model and fell back to nonbinary (budget was ${seen.maxTokens})`,
    ).toBe("boy");
  });

  it("asks for enough headroom that a short reasoning preamble cannot starve it", async () => {
    const seen = { calls: 0 } as { maxTokens?: number; calls: number };
    const llm = starvingModel({ reasoningTokens: 0, answer: "girl", seen });

    await inferGender(llm, "Ada");

    expect(seen.maxTokens ?? 0).toBeGreaterThanOrEqual(64);
  });
});

describe("inferGender parsing", () => {
  const answering = (answer: string): LLMClient =>
    ({
      async completeResponse(): Promise<string> {
        return answer;
      },
    }) as unknown as LLMClient;

  it("still accepts a bare one-word reply", async () => {
    expect(await inferGender(answering("boy"), "Theo")).toBe("boy");
    expect(await inferGender(answering("girl"), "Ada")).toBe("girl");
    expect(await inferGender(answering("nonbinary"), "Sam")).toBe("nonbinary");
  });

  it("reads the verdict out of a reply that reasons first", async () => {
    // Real shape once the budget allows the model to think out loud.
    expect(
      await inferGender(answering("Theo is short for Theodore, so: boy"), "Theo"),
    ).toBe("boy");
    expect(
      await inferGender(answering("Could be either, but Ada is typically a girl."), "Ada"),
    ).toBe("girl");
  });

  it("takes the conclusion, not an option considered along the way", async () => {
    expect(
      await inferGender(answering("This could be a girl name, but here it reads as a boy."), "Theo"),
    ).toBe("boy");
  });

  it("does not read a verdict out of an unrelated substring", async () => {
    expect(await inferGender(answering("boyish-sounding but unclear"), "Ray")).toBe("nonbinary");
  });

  it("stays nonbinary for an empty or unusable reply", async () => {
    expect(await inferGender(answering(""), "Sam")).toBe("nonbinary");
    expect(await inferGender(answering("I cannot determine that."), "Sam")).toBe("nonbinary");
  });

  it("stays nonbinary when the call fails outright", async () => {
    const failing = {
      async completeResponse(): Promise<string> {
        throw new Error("Unexpected response from openrouter");
      },
    } as unknown as LLMClient;
    expect(await inferGender(failing, "Theo")).toBe("nonbinary");
  });
});
