/**
 * GitHub #200: production logged "401 User not found." from routing-client.js
 * nine times in about a minute. OpenRouter sends that when the API key is
 * invalid. A rejected credential is deterministic, so retrying it only makes
 * the player wait. These tests check that a 401/403 is surfaced after one call
 * and that the provider whose key failed is logged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();
vi.mock("openai", () => ({
  default: class FakeOpenAI {
    static RateLimitError = class extends Error {};
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
  },
}));

const errorLog = vi.fn();
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => errorLog(...a), debug: vi.fn() },
}));

const { RoutingLLMClient, isAuthError } = await import("../src/llm/routing-client.js");

function authError(status = 401) {
  return Object.assign(new Error(`${status} User not found.`), { status });
}

describe("provider auth failures (#200)", () => {
  beforeEach(() => {
    createMock.mockReset();
    errorLog.mockReset();
  });

  it("classifies 401 and 403 as auth errors, and nothing else", () => {
    expect(isAuthError(authError(401))).toBe(true);
    expect(isAuthError(authError(403))).toBe(true);
    expect(isAuthError(Object.assign(new Error("x"), { status: 500 }))).toBe(false);
    expect(isAuthError(new Error("no status"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });

  it("non-streaming completeResponse does not retry a 401", async () => {
    createMock.mockRejectedValue(authError());
    const client = new RoutingLLMClient();
    await expect(client.completeResponse("sys", "user", 100, "kid_family_chat")).rejects.toThrow(/User not found/);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "llm_provider_auth_failed",
      expect.objectContaining({ provider: "openrouter", status: 401, streaming: false }),
    );
  });

  it("completeJson does not multiply a 401 through its outer retry", async () => {
    createMock.mockRejectedValue(authError());
    const client = new RoutingLLMClient();
    await expect(client.completeJson("sys", "user", "kid_family_chat")).rejects.toThrow(/User not found/);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("streaming completeResponse does not retry a 401", async () => {
    createMock.mockRejectedValue(authError());
    const client = new RoutingLLMClient();
    await expect(
      client.completeResponse("sys", "user", 100, "kid_family_chat", () => {}),
    ).rejects.toThrow(/User not found/);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "llm_provider_auth_failed",
      expect.objectContaining({ provider: "openrouter", streaming: true }),
    );
  });

  it("streamResponse logs the failing provider", async () => {
    createMock.mockRejectedValue(authError(403));
    const client = new RoutingLLMClient();
    await expect(client.streamResponse("sys", [], () => {}, "kid_family_chat")).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "llm_provider_auth_failed",
      expect.objectContaining({ provider: "openrouter", status: 403 }),
    );
  });
});
