import type { LLMRole } from "./model-config.js";

/**
 * Wall-clock ceiling for a single LLM request, streaming or not.
 *
 * These used to differ: 120s streaming, 90s non-streaming. That was backwards.
 * A streaming call delivers tokens progressively, so its budget covers
 * time-to-*last*-token while the player watches text arrive; a non-streaming
 * call must finish entirely within its budget with nothing on screen. The path
 * that needs more headroom had less.
 *
 * It is not theoretical: `world_manager` (scene generation) runs non-streaming
 * via `completeJson`, and a production call was measured at 74.9s emitting 4023
 * output tokens — 83% of the old 90s ceiling. `withRetry` deliberately does not
 * retry timeouts (see `withRetry` in routing-client.ts), so one slow response was a total
 * failure, surfaced to both players as a dead scene.
 */
export const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

/**
 * Token + cost accounting for a single LLM call. OpenRouter returns token
 * counts and (usually) a USD cost in the response body; the cost tracker logs
 * one of these per call. See docs/monetization-strategy.md §3.2.
 */
export interface LLMUsage {
  role: LLMRole;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Called once per LLM call with its usage, when a client is cost-aware. */
export type UsageSink = (usage: LLMUsage) => void;

/**
 * The interface the ConversationEngine depends on. Both the real OpenRouter
 * client and the mock implement this. Keeping it narrow (three primitives)
 * means the engine never has to know which roles map to streaming vs.
 * completion calls. The optional `role` selects the per-role model
 * (model-config.ts); when omitted, implementations fall back to a sensible
 * default so existing callers and tests keep working.
 */
export interface LLMClient {
  streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string>;

  completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string>;

  completeJson<T>(system: string, userMessage: string, role?: LLMRole, maxTokens?: number): Promise<T>;
}
