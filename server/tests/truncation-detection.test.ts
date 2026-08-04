/**
 * A response cut off mid-thought must be diagnosable, not silent.
 *
 * The empty-content failover only catches the case where reasoning consumed the
 * WHOLE budget. The adjacent failure is partial: reasoning plus content overrun
 * the budget, so the provider returns `finish_reason: "length"` with real but
 * truncated text. That string is non-empty, so nothing downstream notices —
 * a JSON role surfaces it as an opaque parse error (and the outer withRetry in
 * completeJson retries it three times, each equally truncated), and a prose role
 * ships a mid-sentence cutoff straight to the player.
 *
 * REASONING_TOKEN_ALLOWANCE is a measured guess (2500, against an observed burn
 * of 2788 on one probe), and prompt size grows as a game accumulates context, so
 * this WILL happen. The number will always be a guess; detection is the thing we
 * can actually rely on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();
const warnMock = vi.fn();

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
  logger: { warn: (...a: unknown[]) => warnMock(...a), info: () => {}, error: () => {} },
}));

const { RoutingLLMClient } = await import("../src/llm/routing-client.js");

const truncated = () => ({
  choices: [{ message: { content: "The scene begins and then just st" }, finish_reason: "length" }],
  usage: { prompt_tokens: 900, completion_tokens: 4000 },
});
const complete = () => ({
  choices: [{ message: { content: "a whole answer" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 900, completion_tokens: 120 },
});

function truncationWarnings() {
  return warnMock.mock.calls.filter((c) => c[0] === "llm_truncated");
}

describe("truncated responses are logged", () => {
  beforeEach(() => {
    createMock.mockReset();
    warnMock.mockReset();
  });

  it("warns when the provider stopped because it ran out of budget", async () => {
    createMock.mockImplementation(async () => truncated());

    const out = await new RoutingLLMClient().completeResponse("sys", "user", 1500, "psychologist");

    expect(out, "truncated text should still be returned, not thrown away").toBe(
      "The scene begins and then just st",
    );
    const warnings = truncationWarnings();
    expect(
      warnings.length,
      "a cut-off response looks like a random parse error with nothing in the logs",
    ).toBe(1);
    expect(warnings[0]?.[1]).toMatchObject({ role: "psychologist", model: "qwen/qwen3.7-max" });
  }, 30_000);

  it("stays quiet when the model finished on its own", async () => {
    createMock.mockImplementation(async () => complete());
    await new RoutingLLMClient().completeResponse("sys", "user", 1500, "psychologist");
    expect(
      truncationWarnings(),
      "warning on a healthy response would make the signal useless",
    ).toHaveLength(0);
  }, 30_000);

  it("warns on the streaming path too", async () => {
    createMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "half a sen" }, finish_reason: "length" }] };
      },
    }));

    await new RoutingLLMClient().completeResponse("sys", "user", 1500, "epilogue", () => {});

    expect(
      truncationWarnings().length,
      "a keepsake epilogue cut off mid-sentence leaves no trace",
    ).toBe(1);
  }, 30_000);
});
