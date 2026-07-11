import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkOpenAiModeration } from "../src/safety/openai-moderation.js";

describe("checkOpenAiModeration", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  });

  it("is not flagged when OPENAI_API_KEY is unset (no call made)", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await checkOpenAiModeration("anything");
    expect(result).toEqual({ flagged: false, categories: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flags on the sexual/minors category", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ flagged: true, categories: { "sexual/minors": true, sexual: true, violence: false } }],
        }),
        { status: 200 }
      )
    );

    const result = await checkOpenAiModeration("flagged text");
    expect(result.flagged).toBe(true);
    expect(result.categories.sort()).toEqual(["sexual", "sexual/minors"]);
  });

  it("does not flag on unrelated categories (e.g. violence)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ flagged: true, categories: { violence: true, sexual: false } }] }),
        { status: 200 }
      )
    );

    const result = await checkOpenAiModeration("some violent text");
    expect(result.flagged).toBe(false);
    expect(result.categories).toEqual([]);
  });

  it("fails open on a non-2xx response", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    const result = await checkOpenAiModeration("anything");
    expect(result).toEqual({ flagged: false, categories: [] });
  });

  it("fails open when the fetch call throws", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const result = await checkOpenAiModeration("anything");
    expect(result).toEqual({ flagged: false, categories: [] });
  });
});
