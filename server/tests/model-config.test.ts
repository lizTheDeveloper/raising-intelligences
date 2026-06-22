import { describe, it, expect } from "vitest";
import {
  STANDARD_MODELS,
  PREMIUM_MODELS,
  selectModel,
  estimateCostUsd,
} from "../src/llm/model-config.js";

describe("model-config", () => {
  it("routes the standard tier to the models in the monetization doc", () => {
    expect(selectModel("kid_family_chat")).toBe("deepseek/deepseek-v4-flash");
    expect(selectModel("kid_sidebar")).toBe("deepseek/deepseek-v4-flash");
    expect(selectModel("kid_adult_chat")).toBe("qwen/qwen3.7-plus");
    expect(selectModel("world_manager")).toBe("qwen/qwen3.7-plus");
    expect(selectModel("psychologist")).toBe("qwen/qwen3.7-plus");
    expect(selectModel("epilogue")).toBe("qwen/qwen3.7-plus");
    expect(selectModel("report_card")).toBe("qwen/qwen3.7-plus");
  });

  it("upgrades the keepsake artifacts to Claude Opus in the premium tier", () => {
    expect(selectModel("psychologist", "premium")).toBe("google/gemini-2.5-flash");
    expect(selectModel("epilogue", "premium")).toBe("anthropic/claude-opus-4-8");
    expect(selectModel("report_card", "premium")).toBe("anthropic/claude-opus-4-8");
  });

  it("standard tier defaults match when tier is omitted", () => {
    expect(STANDARD_MODELS.kid_family_chat).toBe(selectModel("kid_family_chat"));
    expect(PREMIUM_MODELS.report_card).toBe(selectModel("report_card", "premium"));
  });

  it("estimates cost from token counts and per-model pricing", () => {
    // 1M input + 1M output of deepseek-v4-flash = $0.09 + $0.18 = $0.27
    expect(estimateCostUsd("deepseek/deepseek-v4-flash", 1_000_000, 1_000_000)).toBeCloseTo(
      0.27,
      5
    );
    // qwen3.7-max: 200k in, 50k out = 0.25 + 0.1875 = 0.4375
    expect(estimateCostUsd("qwen/qwen3.7-max", 200_000, 50_000)).toBeCloseTo(0.4375, 5);
  });

  it("returns zero cost for unknown models rather than throwing", () => {
    expect(estimateCostUsd("unknown/model", 1000, 1000)).toBe(0);
  });
});
