import { describe, it, expect, beforeEach, vi } from "vitest";
import { hashGameId, selectKidModel, _resetPoolCacheForTests, _setPoolForTests } from "../src/llm/model-config.js";
import type { PoolEntry } from "../src/llm/model-config.js";

describe("hashGameId", () => {
  it("returns a deterministic value for the same gameId", () => {
    const a = hashGameId("game-abc-123", 10);
    const b = hashGameId("game-abc-123", 10);
    expect(a).toBe(b);
  });

  it("returns different values for different gameIds", () => {
    const a = hashGameId("game-abc-123", 1000);
    const b = hashGameId("game-xyz-789", 1000);
    expect(a).not.toBe(b);
  });

  it("result is always in [0, totalWeight)", () => {
    for (let i = 0; i < 100; i++) {
      const val = hashGameId(`game-${i}`, 5);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(5);
    }
  });
});

describe("selectKidModel", () => {
  const pool: PoolEntry[] = [
    { slug: "model-a", freeSlug: null, weight: 1 },
    { slug: "model-b", freeSlug: "model-b:free", weight: 2 },
    { slug: "model-c", freeSlug: null, weight: 1 },
  ];

  beforeEach(() => {
    _resetPoolCacheForTests();
    _setPoolForTests("standard", pool);
  });

  it("returns a primary model from the pool", async () => {
    const result = await selectKidModel("standard", "game-test-1");
    const allSlugs = pool.flatMap((p) => [p.slug, p.freeSlug].filter(Boolean));
    expect(allSlugs).toContain(result.primary);
  });

  it("is sticky — same gameId always gets same selection", async () => {
    const a = await selectKidModel("standard", "game-sticky-test");
    const b = await selectKidModel("standard", "game-sticky-test");
    expect(a).toEqual(b);
  });

  it("distributes across the pool (not all the same primary model)", async () => {
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      results.add((await selectKidModel("standard", `game-dist-${i}`)).primary);
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it("prefers free_slug when present, and exposes the paid slug as fallback", async () => {
    // model-b has free_slug "model-b:free" and weight 2
    // With enough tries, some gameId should land on model-b
    const results: Array<{ primary: string; fallback: string | null }> = [];
    for (let i = 0; i < 100; i++) {
      results.push(await selectKidModel("standard", `game-free-${i}`));
    }
    const primaries = results.map((r) => r.primary);
    expect(primaries).toContain("model-b:free");
    expect(primaries).not.toContain("model-b");
    const freeHit = results.find((r) => r.primary === "model-b:free");
    expect(freeHit?.fallback).toBe("model-b");
  });

  it("has no fallback for pool entries without a free tier", async () => {
    // model-a and model-c have no freeSlug, so primary === slug and there is
    // nothing to retry with on a 429/404.
    const results: Array<{ primary: string; fallback: string | null }> = [];
    for (let i = 0; i < 100; i++) {
      results.push(await selectKidModel("standard", `game-nofree-${i}`));
    }
    const noFreeHit = results.find((r) => r.primary === "model-a" || r.primary === "model-c");
    expect(noFreeHit?.fallback).toBeNull();
  });

  it("falls back to hardcoded model when pool is empty", async () => {
    _setPoolForTests("standard", []);
    const result = await selectKidModel("standard", "game-empty-pool");
    // Falls back to selectModel("kid_family_chat", "standard") = "deepseek/deepseek-v4-flash"
    expect(result.primary).toBe("deepseek/deepseek-v4-flash");
    expect(result.fallback).toBeNull();
  });
});
