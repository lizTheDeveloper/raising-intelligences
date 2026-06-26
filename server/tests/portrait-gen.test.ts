import { describe, it, expect, beforeEach } from "vitest";
import { generateMomentIllustrations } from "../src/portrait-gen.js";

describe("generateMomentIllustrations", () => {
  beforeEach(() => {
    process.env.DISABLE_PORTRAITS = "1";
  });

  it("returns null paths when portraits are disabled", async () => {
    const results = await generateMomentIllustrations("550e8400-e29b-41d4-a716-446655440000", [
      { visualPrompt: "toddler at table", sortOrder: 0 },
      { visualPrompt: "child on bike", sortOrder: 1 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ sortOrder: 0, imagePath: null });
    expect(results[1]).toEqual({ sortOrder: 1, imagePath: null });
  });

  it("returns empty array for empty input", async () => {
    const results = await generateMomentIllustrations("550e8400-e29b-41d4-a716-446655440000", []);
    expect(results).toHaveLength(0);
  });

  it("returns null paths for invalid game ID", async () => {
    const results = await generateMomentIllustrations("not-a-uuid", [
      { visualPrompt: "test", sortOrder: 0 },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].imagePath).toBeNull();
  });
});
