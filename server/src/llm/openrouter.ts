import OpenAI from "openai";
import type { LLMClient, LLMUsage, UsageSink } from "./client.js";
import {
  type LLMRole,
  type ModelTier,
  estimateCostUsd,
  selectModel,
} from "./model-config.js";

/**
 * OpenRouter-backed LLM client (replaces the direct Anthropic SDK).
 *
 * OpenRouter exposes an OpenAI-compatible API, so we drive it with the `openai`
 * package pointed at https://openrouter.ai/api/v1. The model used for each call
 * is chosen per-role from model-config.ts according to the client's tier, which
 * lets the cheap Kid role and the expensive Report Card share one client.
 *
 * Every call reports token usage and USD cost through the optional `onUsage`
 * sink so per-game cost can be tracked (docs/monetization-strategy.md §3.2).
 */
export class OpenRouterLLMClient implements LLMClient {
  private client: OpenAI;

  constructor(
    private readonly tier: ModelTier = "standard",
    private readonly onUsage?: UsageSink,
    /** Fallback model when a call supplies no role (e.g. legacy callers/tests). */
    private readonly defaultRole: LLMRole = "kid_family_chat"
  ) {
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        "HTTP-Referer": "https://raisingintelligences.com",
        "X-Title": "Raising Intelligences",
      },
    });
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    const resolvedRole = role ?? this.defaultRole;
    const model = selectModel(resolvedRole, this.tier);

    const promptMessages =
      messages.length > 0
        ? messages
        : [
            {
              role: "user" as const,
              content: "(The child looks at their parents, waiting.)",
            },
          ];

    const stream = await this.client.chat.completions.create({
      model,
      max_tokens: 500,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: system }, ...promptMessages],
    }, { signal: AbortSignal.timeout(45_000) });

    let fullResponse = "";
    let usage: OpenAIUsage | undefined;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullResponse += delta;
        onChunk(delta);
      }
      if (chunk.usage) usage = chunk.usage as OpenAIUsage;
    }

    this.report(resolvedRole, model, usage);
    return fullResponse;
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens = 1500,
    role?: LLMRole
  ): Promise<string> {
    const resolvedRole = role ?? this.defaultRole;
    const model = selectModel(resolvedRole, this.tier);

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    }, { signal: AbortSignal.timeout(60_000) });

    this.report(resolvedRole, model, response.usage as OpenAIUsage | undefined);

    const content = response.choices[0]?.message?.content;
    if (typeof content === "string") return content;
    throw new Error("Unexpected response type from OpenRouter");
  }

  async completeJson<T>(system: string, userMessage: string, role?: LLMRole): Promise<T> {
    const text = await this.completeResponse(system, userMessage, 500, role);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    return JSON.parse(jsonMatch[0]) as T;
  }

  /** Emit token + cost accounting for a completed call, if a sink is wired. */
  private report(role: LLMRole, model: string, usage: OpenAIUsage | undefined): void {
    if (!this.onUsage || !usage) return;
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    // OpenRouter returns the real charged cost under usage.cost (USD); fall back
    // to our pricing table when it is absent.
    const costUsd =
      typeof usage.cost === "number"
        ? usage.cost
        : estimateCostUsd(model, inputTokens, outputTokens);

    const record: LLMUsage = { role, model, inputTokens, outputTokens, costUsd };
    this.onUsage(record);
  }
}

/** OpenAI-shaped usage, widened with OpenRouter's non-standard `cost` field. */
type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
};
