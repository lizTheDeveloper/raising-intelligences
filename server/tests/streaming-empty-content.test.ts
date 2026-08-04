/**
 * A streamed turn that produces no text must not reach the player as silence.
 *
 * The non-streaming path throws `Unexpected response from ...` when content is
 * null, which is what the empty-content failover hangs off. The streaming path
 * had no such check: it accumulated deltas into `fullResponse` and returned it
 * even when the stream carried no content at all. A reasoning model that spends
 * its whole budget thinking emits zero content deltas, so the call "succeeded"
 * with an empty string — the child said nothing, no error surfaced, and no
 * `llm_empty_content_failover` warning was logged.
 *
 * That silence is why the 2026-08-04 production logs showed only three roles
 * failing over. `psychologist` (conversation-engine.ts, endScene),
 * `psychologist_consult` and `family_therapist` all stream, so their empty
 * responses were invisible in the logs rather than absent.
 *
 * Retrying is safe here in a way it is not mid-sentence: this fires only when
 * nothing was ever emitted, so the `emittedAny` guard against duplicating
 * visible text still holds.
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

const { RoutingLLMClient, EMPTY_CONTENT_FAILOVER_MODEL } = await import(
  "../src/llm/routing-client.js"
);

/** A stream that reasons for its whole budget and never emits content. */
const emptyStream = () => ({
  async *[Symbol.asyncIterator]() {
    yield { choices: [{ delta: {} }], usage: undefined };
  },
});

const streamSaying = (text: string) => ({
  async *[Symbol.asyncIterator]() {
    yield { choices: [{ delta: { content: text } }], usage: undefined };
  },
});

describe("streamed empty responses fail over instead of returning silence", () => {
  beforeEach(() => createMock.mockReset());

  it("fails over to another family when the stream carries no content", async () => {
    const seen: string[] = [];
    createMock.mockImplementation(async (args?: { model?: string }) => {
      seen.push(args?.model ?? "MISSING");
      return args?.model === EMPTY_CONTENT_FAILOVER_MODEL
        ? streamSaying("the psychologist speaks")
        : emptyStream();
    });

    const chunks: string[] = [];
    const out = await new RoutingLLMClient().completeResponse(
      "sys",
      "user",
      1500,
      "psychologist",
      (c) => chunks.push(c),
    );

    expect(out, "the player was handed an empty message").toBe("the psychologist speaks");
    expect(chunks.join("")).toBe("the psychologist speaks");
    expect(seen.at(-1)).toBe(EMPTY_CONTENT_FAILOVER_MODEL);
  }, 30_000);

  it("does not fail over once the player has seen text", async () => {
    // The safety property that makes streaming retries legal at all: if any
    // token already reached the player, re-running would duplicate visible text.
    const seen: string[] = [];
    createMock.mockImplementation(async (args?: { model?: string }) => {
      seen.push(args?.model ?? "MISSING");
      return streamSaying("real answer");
    });

    const out = await new RoutingLLMClient().completeResponse(
      "sys",
      "user",
      1500,
      "psychologist",
      () => {},
    );

    expect(out).toBe("real answer");
    expect(seen).toHaveLength(1);
    expect(seen.includes(EMPTY_CONTENT_FAILOVER_MODEL)).toBe(false);
  }, 30_000);
});
