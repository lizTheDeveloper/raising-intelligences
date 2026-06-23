import type { LLMRole } from "./model-config.js";

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
