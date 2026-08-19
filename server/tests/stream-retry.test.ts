/**
 * A stream that dies before the player sees anything should be retried;
 * one that dies mid-sentence must NOT be, or the player gets duplicated text.
 *
 * The non-streaming path has always retried via withRetry. The streaming path
 * had no retry at all, so a single upstream hiccup during iteration went
 * straight to the player as a failed message. Seen in production twice:
 *   2026-08-03 11:51:15Z  "Upstream error from Alibaba: Output data may
 *                          contain inappropriate content"
 *   2026-08-03 17:50:59Z  "JSON error injected into SSE stream"
 * both thrown out of the OpenAI SDK stream iterator inside handleParentMessage.
 *
 * These drive RoutingLLMClient against a fake OpenAI whose stream fails on cue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Build an async-iterable that yields deltas then optionally throws. */
function fakeStream(deltas: string[], throwAfter: number | null) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < deltas.length; i++) {
        if (throwAfter !== null && i === throwAfter) {
          throw new Error("JSON error injected into SSE stream");
        }
        yield { choices: [{ delta: { content: deltas[i] } }] };
      }
      if (throwAfter !== null && throwAfter >= deltas.length) {
        throw new Error("JSON error injected into SSE stream");
      }
    },
  };
}

const createMock = vi.fn();
vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
  },
}));

const { RoutingLLMClient } = await import("../src/llm/routing-client.js");

describe("streaming retry", () => {
  beforeEach(() => {
    createMock.mockReset();
    vi.useRealTimers();
  });

  it("retries when the stream dies before the first token", async () => {
    createMock
      .mockImplementationOnce(async () => fakeStream([], 0)) // dies immediately
      .mockImplementationOnce(async () => fakeStream(["hello ", "world"], null));

    const client = new RoutingLLMClient();
    const seen: string[] = [];
    const out = await client.completeResponse("sys", "user", 100, "kid_family_chat", (c) =>
      seen.push(c),
    );

    expect(out).toBe("hello world");
    expect(seen.join("")).toBe("hello world");
    expect(createMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("does NOT retry once the player has seen a token — no duplicated text", async () => {
    // Emits one token, then dies. Retrying would replay "the child ".
    createMock.mockImplementation(async () => fakeStream(["the child "], 1));

    const client = new RoutingLLMClient();
    const seen: string[] = [];

    await expect(
      client.completeResponse("sys", "user", 100, "kid_family_chat", (c) => seen.push(c)),
    ).rejects.toThrow(/JSON error injected/);

    expect(
      seen.join(""),
      "text was replayed to the player after a mid-stream failure",
    ).toBe("the child ");
    expect(createMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("gives up after the attempt cap rather than looping forever", async () => {
    createMock.mockImplementation(async () => fakeStream([], 0));

    const client = new RoutingLLMClient();
    await expect(
      client.completeResponse("sys", "user", 100, "kid_family_chat", () => {}),
    ).rejects.toThrow(/JSON error injected/);

    expect(createMock).toHaveBeenCalledTimes(3);
  }, 30_000);
});
