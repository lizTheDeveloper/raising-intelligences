/**
 * A cut-off answer must be retried with more room, not shipped to the player.
 *
 * Production, 2026-08-04, within hours of shipping `llm_truncated`:
 *   llm_truncated world_manager qwen3.7-plus outputTokens=4002 reasoningTokens=3859
 *   llm_truncated report_card   qwen3.7-max  outputTokens=4002 reasoningTokens=2869
 *
 * 4002 is the ceiling itself (1500 requested + 2500 allowance), so both calls
 * were cut off rather than finished. A real player's report card — a keepsake
 * artifact they keep at the end of a whole game — was truncated mid-generation.
 *
 * The lesson from the 3859 case is that a constant cannot solve this. That call
 * was already capped, so we do not know what it actually wanted; picking a
 * bigger number just moves the cliff. Escalating on the evidence of a real
 * truncation is self-correcting in a way a guess is not.
 *
 * max_tokens is a CEILING, not a target — the model bills only what it
 * generates, and measurements show reasoning does not expand to fill the budget
 * (at 4000 qwen3.7-max reasoned 2788; at 8000 it reasoned 1360). So retrying
 * with more room costs nothing when the model does not need it.
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
vi.mock("../src/logger.js", () => ({
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}));

const { RoutingLLMClient } = await import("../src/llm/routing-client.js");

const cutOff = () => ({
  choices: [{ message: { content: "The report card begins and then st" }, finish_reason: "length" }],
  usage: { prompt_tokens: 900, completion_tokens: 4002 },
});
const finished = (text: string) => ({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 900, completion_tokens: 2200 },
});

/** max_tokens sent on each upstream call, in order. */
function budgets(): number[] {
  return createMock.mock.calls.map((c) => (c[0] as { max_tokens: number }).max_tokens);
}

describe("a truncated answer is retried with more room", () => {
  beforeEach(() => createMock.mockReset());

  it("retries with a larger budget and returns the complete answer", async () => {
    let calls = 0;
    createMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? cutOff() : finished("a complete report card");
    });

    const out = await new RoutingLLMClient().completeResponse("s", "u", 1500, "report_card");

    expect(out, "the player kept a report card that stops mid-sentence").toBe(
      "a complete report card",
    );
    const sent = budgets();
    expect(sent).toHaveLength(2);
    expect(
      sent[1]! > sent[0]!,
      `retried with the same budget (${sent[0]} -> ${sent[1]}) — it will truncate identically`,
    ).toBe(true);
  }, 30_000);

  it("does not retry an answer the model finished on its own", async () => {
    createMock.mockImplementation(async () => finished("all done"));
    const out = await new RoutingLLMClient().completeResponse("s", "u", 1500, "report_card");
    expect(out).toBe("all done");
    expect(budgets(), "burning a second paid call on a healthy response").toHaveLength(1);
  }, 30_000);

  it("gives up after escalating rather than looping forever", async () => {
    // Some prompts genuinely cannot fit. Returning the truncated text beats
    // hanging the player behind an unbounded escalation.
    createMock.mockImplementation(async () => cutOff());
    const out = await new RoutingLLMClient().completeResponse("s", "u", 1500, "report_card");

    expect(out).toBe("The report card begins and then st");
    expect(budgets().length).toBeLessThanOrEqual(3);
    expect(budgets().length).toBeGreaterThan(1);
  }, 40_000);

  it("does not retry a stream the player is already reading", async () => {
    // Re-running would duplicate visible text mid-sentence. The truncation is
    // logged instead; that guard matters more than the retry.
    createMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "half a sen" }, finish_reason: "length" }] };
      },
    }));

    const out = await new RoutingLLMClient().completeResponse("s", "u", 1500, "epilogue", () => {});

    expect(out).toBe("half a sen");
    expect(budgets(), "duplicated visible text mid-sentence").toHaveLength(1);
  }, 30_000);
});
