/**
 * A reasoning model must be given room to reason AND still answer.
 *
 * Production, 2026-08-04. Every qwen call in a 70-minute window returned
 * `completion_tokens: 1502` — 59 of 59, a constant rather than a distribution.
 * Probed directly against OpenRouter with a game-sized psychologist prompt:
 *
 *   max_tokens=1500 -> finish=length, reasoning=1500, content=null
 *   max_tokens=4000 -> finish=stop,   reasoning=2788, content=<real JSON>
 *
 * qwen3.7 reasons before it answers, and OpenRouter counts reasoning tokens
 * against `max_tokens`. Our 1500 default was consumed entirely by reasoning, so
 * the model never emitted a single content token. This was diagnosed as an
 * OpenRouter outage on 2026-08-03; it is not one. The provider is healthy and
 * the fault is deterministic — it reproduces on every sufficiently long prompt
 * and would never have "recovered".
 *
 * Capping reasoning instead of adding headroom was measured and rejected:
 * `reasoning.effort: "low"` and `reasoning.exclude: true` both still burned the
 * full 1500, and `reasoning.max_tokens: 400` left qwen3.7-plus truncated
 * mid-JSON (finish=length). Headroom is the lever that works for both models.
 *
 * `maxTokens` at the call site means "content I want back", so the allowance is
 * added on top rather than carved out of it — otherwise fixing the empty
 * responses would silently shorten every epilogue and report card.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();
vi.mock("openai", () => {
  class RateLimitError extends Error {}
  return {
    default: class FakeOpenAI {
      static RateLimitError = RateLimitError;
      chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    },
  };
});

const { RoutingLLMClient } = await import("../src/llm/routing-client.js");
const { REASONING_TOKEN_ALLOWANCE, isReasoningModel } = await import(
  "../src/llm/model-config.js"
);

const says = (t: string) => ({ choices: [{ message: { content: t } }], usage: undefined });

/** The budget actually sent upstream for the first call. */
function sentMaxTokens(): number {
  return (createMock.mock.calls[0]?.[0] as { max_tokens: number }).max_tokens;
}

describe("reasoning models get budget for reasoning on top of content", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockImplementation(async () => says("answered"));
  });

  it("knows which models reason before answering", () => {
    expect(isReasoningModel("qwen/qwen3.7-max")).toBe(true);
    expect(isReasoningModel("qwen/qwen3.7-plus")).toBe(true);
    expect(isReasoningModel("deepseek/deepseek-v4-flash")).toBe(false);
    expect(isReasoningModel("anthropic/claude-haiku-4-5")).toBe(false);
  });

  it("adds the reasoning allowance for a qwen role", async () => {
    // psychologist runs on qwen/qwen3.7-max and asks for the 1500 default.
    await new RoutingLLMClient().completeResponse("sys", "user", 1500, "psychologist");

    expect(
      sentMaxTokens(),
      "reasoning eats the whole budget and the model returns content: null",
    ).toBe(1500 + REASONING_TOKEN_ALLOWANCE);
  });

  it("sends a budget that measurably clears the observed reasoning burn", async () => {
    /**
     * Every reasoning burn seen in production or probing, in tokens:
     *   2189, 2788, 2869, 3859, 3861
     * The 3861 was personality_seed on 2026-08-04 — it finished reasoning and
     * was then cut off with only ~141 tokens left for the answer, on a game's
     * opening call while the player waited. The budget therefore has to clear
     * the worst observed burn AND still leave room to write, not merely exceed
     * it. This costs nothing when unused: max_tokens is a ceiling, and the model
     * bills only what it generates.
     */
    await new RoutingLLMClient().completeResponse("sys", "user", 1500, "psychologist");
    const WORST_OBSERVED_REASONING_BURN = 3861;
    expect(sentMaxTokens()).toBeGreaterThan(WORST_OBSERVED_REASONING_BURN + 1500);
  });

  it("does not inflate the budget for a non-reasoning model", async () => {
    // kid_family_chat runs on deepseek, which does not reason. Padding it would
    // be a silent cost increase on the highest-volume role in the game.
    await new RoutingLLMClient().completeResponse("sys", "user", 1500, "kid_family_chat");
    expect(sentMaxTokens()).toBe(1500);
  });

  it("applies the allowance on the streaming path too", async () => {
    createMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "hi" } }] };
      },
    }));

    await new RoutingLLMClient().completeResponse(
      "sys",
      "user",
      1500,
      "psychologist",
      () => {},
    );

    expect(
      sentMaxTokens(),
      "streamed psychologist turns would still come back empty",
    ).toBe(1500 + REASONING_TOKEN_ALLOWANCE);
  });
});
