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
  | "memory_summarizer"
  | "epilogue"
  | "report_card"
  | "album"
  | "personality_seed"
  | "gender_inference"
  | "safety_check"
  | "psychologist_consult"
  | "family_therapist"
  | "cps_caseworker";

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
  memory_summarizer: "qwen/qwen3.7-max",
  epilogue: "qwen/qwen3.7-max",
  report_card: "qwen/qwen3.7-max",
  album: "qwen/qwen3.7-max",
  personality_seed: "qwen/qwen3.7-max",
  gender_inference: "deepseek/deepseek-v4-flash",
  // Safety classification is not a cost lever — same reliable model on every
  // tier, regardless of what the player is paying. See safety/pattern-detection.ts (grooming-pattern check, runs once per scene).
  safety_check: "anthropic/claude-haiku-4-5",
  // Dark Play intervention ladder — same quality bar as the Psychologist,
  // since these are the highest-stakes reads in the game (monetization-strategy.md §3.1).
  psychologist_consult: "qwen/qwen3.7-max",
  family_therapist: "qwen/qwen3.7-max",
  cps_caseworker: "qwen/qwen3.7-max",
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
  memory_summarizer: "cerebras:gpt-oss-120b",
  epilogue:        "cerebras:gpt-oss-120b",
  report_card:     "cerebras:gpt-oss-120b",
  album:           "cerebras:gpt-oss-120b",
  personality_seed: "cerebras:gpt-oss-120b",
  gender_inference: "cerebras:gpt-oss-120b",
  // Not routed through Cerebras — safety classification stays on the same
  // reliable model across every tier. See safety/pattern-detection.ts (grooming-pattern check, runs once per scene).
  safety_check: "anthropic/claude-haiku-4-5",
  psychologist_consult: "cerebras:gpt-oss-120b",
  family_therapist: "cerebras:gpt-oss-120b",
  cps_caseworker: "cerebras:gpt-oss-120b",
};

/** Premium tier: Qwen Max + Gemini 2.5 Flash + Claude Opus 4.8 for the keepsake artifacts. */
export const PREMIUM_MODELS: ModelConfig = {
  kid_family_chat: "qwen/qwen3.7-plus",
  kid_sidebar: "qwen/qwen3.7-plus",
  kid_adult_chat: "qwen/qwen3.7-max",
  world_manager: "qwen/qwen3.7-max",
  psychologist: "google/gemini-2.5-flash",
  memory_summarizer: "google/gemini-2.5-flash",
  epilogue: "anthropic/claude-opus-4-8",
  report_card: "anthropic/claude-opus-4-8",
  album: "anthropic/claude-opus-4-8",
  personality_seed: "google/gemini-2.5-flash",
  gender_inference: "deepseek/deepseek-v4-flash",
  safety_check: "anthropic/claude-haiku-4-5",
  psychologist_consult: "google/gemini-2.5-flash",
  family_therapist: "google/gemini-2.5-flash",
  cps_caseworker: "google/gemini-2.5-flash",
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
  "anthropic/claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

/**
 * Models that emit reasoning tokens before their answer, where the provider
 * counts those tokens against `max_tokens`.
 *
 * Getting this list wrong is not cosmetic: a reasoning model listed here that
 * is not one merely costs a little headroom, but one MISSING from the list
 * returns `content: null` on every prompt long enough to make it think.
 */
const REASONING_MODELS = new Set(["qwen/qwen3.7-plus", "qwen/qwen3.7-max"]);

export function isReasoningModel(model: string): boolean {
  return REASONING_MODELS.has(model);
}

/**
 * Extra `max_tokens` granted to a reasoning model, on top of the content budget
 * the caller asked for.
 *
 * Every reasoning burn observed in production or direct probing, in tokens:
 *   2189, 2788, 2869, 3859, 3861
 *
 * 2500 was set from the first two and proved too small within a day: on
 * 2026-08-04 world_manager (3859), report_card (2869) and personality_seed
 * (3861) all hit the ceiling. personality_seed is the worst case — it finished
 * reasoning and was cut off with ~141 tokens left to answer, on a game's
 * opening call, and the escalation retry that rescued it landed 22 seconds
 * after the player had already given up (499 at 95.9s).
 *
 * 6000 clears the worst observed burn and still leaves room to write.
 *
 * This is NOT free, and the earlier claim in this comment that it was has been
 * withdrawn. max_tokens is a ceiling rather than a target, but a reasoning model
 * given more room does tend to use some of it. Paired measurements on the same
 * prompt disagree on how much — qwen3.7-max reasoned 2788 at a 4000 budget and
 * 1360 at 8000 on one prompt, but 2315 at 4000 and 3074 at 7500 on another
 * (55.6s -> 70.6s, $0.0133 -> $0.0174) — so treat a modest rise in latency and
 * cost as the expected price, not a regression.
 *
 * It is still the right trade: a truncation costs a whole extra round-trip
 * through the escalation in routing-client.ts, on top of a wasted call that
 * produced unusable text. That escalation remains the backstop for prompts that
 * overrun anyway; this constant exists so the backstop is rarely reached,
 * because reaching it is what made a player wait 95 seconds and leave.
 */
export const REASONING_TOKEN_ALLOWANCE = 6000;

/**
 * The budget to send upstream so a model can reason AND still answer.
 * `requested` keeps its meaning of "content tokens the caller wants back".
 */
export function budgetFor(model: string, requested: number): number {
  return isReasoningModel(model) ? requested + REASONING_TOKEN_ALLOWANCE : requested;
}

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
