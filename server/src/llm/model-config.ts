/**
 * Per-role model selection for OpenRouter, following the monetization strategy
 * (docs/monetization-strategy.md §3.1).
 *
 * The Kid role accounts for 70-90% of all LLM calls but only needs short,
 * conversational responses, so it runs on the cheapest viable model. The
 * savings are spent on quality where it matters (Psychologist, Epilogue,
 * Report Card). A premium tier swaps in stronger models for players who buy
 * premium credits.
 */

/**
 * Logical LLM roles. Each maps to a specific model per tier. The Kid splits
 * into three roles because family chat (highest volume, short outputs) can run
 * far cheaper than adult conversations (fewer calls, more nuance).
 */
export type LLMRole =
  | "kid_family_chat"
  | "kid_sidebar"
  | "kid_adult_chat"
  | "world_manager"
  | "psychologist"
  | "epilogue"
  | "report_card"
  | "personality_seed";

export type ModelTier = "standard" | "cerebras" | "premium";

export type ModelConfig = Record<LLMRole, string>;

// Verify slugs against https://openrouter.ai/models before first deploy
/** Standard tier: DeepSeek + Qwen. ~$0.15/typical game. */
export const STANDARD_MODELS: ModelConfig = {
  kid_family_chat: "deepseek/deepseek-v4-flash",
  kid_sidebar: "deepseek/deepseek-v4-flash",
  kid_adult_chat: "qwen/qwen3.7-plus",
  world_manager: "qwen/qwen3.7-plus",
  // The identity update and keepsake artifacts are the quality-critical calls,
  // so the standard tier spends up to Qwen Max here (monetization-strategy.md §3.1).
  psychologist: "qwen/qwen3.7-max",
  epilogue: "qwen/qwen3.7-max",
  report_card: "qwen/qwen3.7-max",
  personality_seed: "qwen/qwen3.7-max",
};

/**
 * Cerebras tier: GPT OSS 120B on Cerebras for all narrative roles.
 * Cerebras runs GPT OSS at extremely high throughput (~1000 tok/s vs ~10 tok/s on OpenRouter).
 * Great at storytelling; kid chat stays on cheap DeepSeek via OpenRouter.
 * The "cerebras:" prefix routes these slugs to api.cerebras.ai in routing-client.ts.
 */
export const CEREBRAS_MODELS: ModelConfig = {
  kid_family_chat: "cerebras:gpt-oss-120b",
  kid_sidebar:     "cerebras:gpt-oss-120b",
  kid_adult_chat:  "cerebras:gpt-oss-120b",
  world_manager:   "cerebras:gpt-oss-120b",
  psychologist:    "cerebras:gpt-oss-120b",
  epilogue:        "cerebras:gpt-oss-120b",
  report_card:     "cerebras:gpt-oss-120b",
  personality_seed: "cerebras:gpt-oss-120b",
};

/** Premium tier: Qwen Max + Gemini 2.5 Flash + Claude Opus 4.8 for the keepsake artifacts. */
export const PREMIUM_MODELS: ModelConfig = {
  kid_family_chat: "qwen/qwen3.7-plus",
  kid_sidebar: "qwen/qwen3.7-plus",
  kid_adult_chat: "qwen/qwen3.7-max",
  world_manager: "qwen/qwen3.7-max",
  psychologist: "google/gemini-2.5-flash",
  epilogue: "anthropic/claude-opus-4-8",
  report_card: "anthropic/claude-opus-4-8",
  personality_seed: "google/gemini-2.5-flash",
};

export const MODELS_BY_TIER: Record<ModelTier, ModelConfig> = {
  standard:  STANDARD_MODELS,
  cerebras:  CEREBRAS_MODELS,
  premium:   PREMIUM_MODELS,
};

/** Per-model pricing in USD per million tokens. Used to compute per-call cost
 * when OpenRouter does not return `usage.cost` in the response body. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "deepseek/deepseek-v4-flash": { input: 0.09, output: 0.18 },
  "qwen/qwen3.7-plus": { input: 0.32, output: 1.28 },
  "qwen/qwen3.7-max": { input: 1.25, output: 3.75 },
  "google/gemini-2.5-flash": { input: 1.5, output: 9.0 },
  "anthropic/claude-opus-4-8": { input: 5.0, output: 25.0 },
};

/** The model that serves a given role at a given tier. Defaults to standard. */
export function selectModel(role: LLMRole, tier: ModelTier = "standard"): string {
  return MODELS_BY_TIER[tier][role];
}

/**
 * Estimate the USD cost of a call from token counts and the model's pricing.
 * Returns 0 for unknown models rather than throwing — cost tracking must never
 * break a game.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}
