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

  it("returns a model from the pool", async () => {
    const result = await selectKidModel("standard", "game-test-1");
    const allSlugs = pool.flatMap((p) => [p.slug, p.freeSlug].filter(Boolean));
    expect(allSlugs).toContain(result);
  });

  it("is sticky — same gameId always gets same model", async () => {
    const a = await selectKidModel("standard", "game-sticky-test");
    const b = await selectKidModel("standard", "game-sticky-test");
    expect(a).toBe(b);
  });

  it("distributes across the pool (not all the same model)", async () => {
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      results.add(await selectKidModel("standard", `game-dist-${i}`));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it("prefers free_slug when present", async () => {
    // model-b has free_slug "model-b:free" and weight 2
    // With enough tries, some gameId should land on model-b
    const results: string[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(await selectKidModel("standard", `game-free-${i}`));
    }
    expect(results).toContain("model-b:free");
    expect(results).not.toContain("model-b");
  });

  it("falls back to hardcoded model when pool is empty", async () => {
    _setPoolForTests("standard", []);
    const result = await selectKidModel("standard", "game-empty-pool");
    // Falls back to selectModel("kid_family_chat", "standard") = "deepseek/deepseek-v4-flash"
    expect(result).toBe("deepseek/deepseek-v4-flash");
  });
});
