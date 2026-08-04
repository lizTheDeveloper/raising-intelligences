/**
 * A model that answers HTTP 200 with no content must not take the game down.
 *
 * Production, 2026-08-04: OpenRouter returned 200 with `content: null` for
 * qwen3.7-max and qwen3.7-plus for over an hour. Reproduced directly with a
 * 32-token "Say OK." on our own key — both qwen models empty, deepseek fine.
 * Eleven roles sit on those two models, so new games could not seed a child
 * (personality_seed), scenes could not end (psychologist), and no epilogue
 * could be written. withRetry cannot help: the fault is deterministic, so all
 * three attempts come back equally empty.
 *
 * The existing rate-limit fallback does not help either — STANDARD_MODELS for
 * these roles is the same qwen model that just failed. The failover therefore
 * has to cross model FAMILIES.
 *
 * This is a circuit breaker, not a downgrade: it must engage only after the
 * primary produced nothing, and must not fire while the primary is healthy.
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

const empty = () => ({ choices: [{ message: { content: null } }], usage: undefined });
const says = (t: string) => ({ choices: [{ message: { content: t } }], usage: undefined });

describe("empty-content failover", () => {
  beforeEach(() => createMock.mockReset());

  it("fails over to another model family when the primary returns no content", async () => {
    const seen: string[] = [];
    createMock.mockImplementation(async (args?: { model?: string }) => {
      seen.push(args?.model ?? "MISSING");
      return args?.model === EMPTY_CONTENT_FAILOVER_MODEL ? says("the psychologist writes") : empty();
    });

    const client = new RoutingLLMClient();
    const out = await client.completeResponse("sys", "user", 100, "psychologist");

    expect(out).toBe("the psychologist writes");
    expect(
      seen.at(-1),
      "never crossed model families — the same empty model was retried forever",
    ).toBe(EMPTY_CONTENT_FAILOVER_MODEL);
  }, 30_000);

  it("does not fire while the primary is healthy", async () => {
    const seen: string[] = [];
    createMock.mockImplementation(async (args?: { model?: string }) => {
      seen.push(args?.model ?? "MISSING");
      return says("primary answered");
    });

    const client = new RoutingLLMClient();
    const out = await client.completeResponse("sys", "user", 100, "psychologist");

    expect(out).toBe("primary answered");
    expect(seen).toHaveLength(1);
    expect(
      seen.includes(EMPTY_CONTENT_FAILOVER_MODEL),
      "failover fired against a healthy primary — that would be a silent downgrade",
    ).toBe(false);
  }, 30_000);

  it("still throws when the failover model is also empty", async () => {
    createMock.mockImplementation(async () => empty());
    const client = new RoutingLLMClient();
    await expect(
      client.completeResponse("sys", "user", 100, "psychologist"),
    ).rejects.toThrow(/Unexpected response/);
  }, 40_000);
});
