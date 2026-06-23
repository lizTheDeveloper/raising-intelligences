import OpenAI from "openai";
import type { LLMClient, LLMUsage, UsageSink } from "./client.js";
import { type LLMRole, type ModelTier, estimateCostUsd, selectModel } from "./model-config.js";

/**
 * Routes LLM calls to different OpenAI-compatible providers based on the
 * model slug prefix.  A slug like "cerebras:gpt-oss-120b" sends the call to
 * Cerebras; an unprefixed slug falls through to OpenRouter.
 *
 * This lets model-config.ts express per-role provider routing without the
 * engine knowing anything about which backend handles each role.
 */
export class RoutingLLMClient implements LLMClient {
  private providers: Map<string, { client: OpenAI; pricing?: Record<string, { input: number; output: number }> }>;
  private fallback: string; // provider key for unprefixed slugs

  constructor(
    private readonly tier: ModelTier = "standard",
    private readonly onUsage?: UsageSink,
    private readonly defaultRole: LLMRole = "kid_family_chat",
    private readonly seed?: number
  ) {
    this.providers = new Map();
    this.fallback = "openrouter";

    this.providers.set("openrouter", {
      client: new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultHeaders: {
          "HTTP-Referer": "https://raisingintelligences.com",
          "X-Title": "Raising Intelligences",
        },
      }),
    });

    if (process.env.CEREBRAS_API_KEY) {
      this.providers.set("cerebras", {
        client: new OpenAI({
          baseURL: "https://api.cerebras.ai/v1",
          apiKey: process.env.CEREBRAS_API_KEY,
        }),
        pricing: {
          "gpt-oss-120b": { input: 0.50, output: 1.50 },
          "zai-glm-4.7":  { input: 0.20, output: 0.60 },
        },
      });
    }
  }

  /** Parse "provider:model" → { provider, model }. Unprefixed → fallback. */
  private resolve(slug: string): { providerKey: string; model: string } {
    const colon = slug.indexOf(":");
    if (colon === -1) return { providerKey: this.fallback, model: slug };
    const providerKey = slug.slice(0, colon);
    const model = slug.slice(colon + 1);
    return this.providers.has(providerKey)
      ? { providerKey, model }
      : { providerKey: this.fallback, model: slug }; // unknown prefix → openrouter passthrough
  }

  private getClient(providerKey: string): OpenAI {
    const p = this.providers.get(providerKey);
    if (!p) throw new Error(`No provider configured for "${providerKey}"`);
    return p.client;
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    const resolvedRole = role ?? this.defaultRole;
    const slug = selectModel(resolvedRole, this.tier);
    const { providerKey, model } = this.resolve(slug);
    const client = this.getClient(providerKey);

    const promptMessages = messages.length > 0
      ? messages
      : [{ role: "user" as const, content: "(The child looks at their parents, waiting.)" }];

    const stream = await client.chat.completions.create({
      model,
      max_tokens: 500,
      stream: true,
      stream_options: { include_usage: true },
      ...(this.seed !== undefined ? { seed: this.seed } : {}),
      messages: [{ role: "system", content: system }, ...promptMessages],
    }, { signal: AbortSignal.timeout(60_000) });

    let fullResponse = "";
    let usage: OpenAIUsage | undefined;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) { fullResponse += delta; onChunk(delta); }
      if (chunk.usage) usage = chunk.usage as OpenAIUsage;
    }
    this.report(resolvedRole, providerKey, model, usage);
    return fullResponse;
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens = 1500,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const resolvedRole = role ?? this.defaultRole;
    const slug = selectModel(resolvedRole, this.tier);
    const { providerKey, model } = this.resolve(slug);
    const client = this.getClient(providerKey);

    const msgs = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: userMessage },
    ];

    if (onChunk) {
      const stream = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(this.seed !== undefined ? { seed: this.seed } : {}),
        messages: msgs,
      }, { signal: AbortSignal.timeout(120_000) });

      let fullResponse = "";
      let usage: OpenAIUsage | undefined;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) { fullResponse += delta; onChunk(delta); }
        if (chunk.usage) usage = chunk.usage as OpenAIUsage;
      }
      this.report(resolvedRole, providerKey, model, usage);
      return fullResponse;
    }

    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      ...(this.seed !== undefined ? { seed: this.seed } : {}),
      messages: msgs,
    }, { signal: AbortSignal.timeout(90_000) });

    this.report(resolvedRole, providerKey, model, response.usage as OpenAIUsage | undefined);
    const content = response.choices[0]?.message?.content;
    if (typeof content === "string") return content;
    throw new Error(`Unexpected response from ${providerKey}`);
  }

  async completeJson<T>(system: string, userMessage: string, role?: LLMRole): Promise<T> {
    const text = await this.completeResponse(system, userMessage, 500, role);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    return JSON.parse(jsonMatch[0]) as T;
  }

  private report(role: LLMRole, providerKey: string, model: string, usage: OpenAIUsage | undefined): void {
    if (!this.onUsage || !usage) return;
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    const providerPricing = this.providers.get(providerKey)?.pricing;
    const costUsd =
      typeof usage.cost === "number"
        ? usage.cost
        : providerPricing?.[model]
          ? (inputTokens / 1_000_000) * providerPricing[model].input +
            (outputTokens / 1_000_000) * providerPricing[model].output
          : estimateCostUsd(model, inputTokens, outputTokens);

    const record: LLMUsage = { role, model: `${providerKey}:${model}`, inputTokens, outputTokens, costUsd };
    this.onUsage(record);
  }
}

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
};
