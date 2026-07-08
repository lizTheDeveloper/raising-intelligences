import OpenAI from "openai";
import type { LLMClient, LLMUsage, UsageSink } from "./client.js";
import { type LLMRole, type ModelTier, estimateCostUsd, selectModel, STANDARD_MODELS } from "./model-config.js";

function isRateLimitError(e: unknown): boolean {
  return e instanceof OpenAI.RateLimitError;
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/**
 * Retry a non-streaming LLM call up to maxAttempts times with exponential
 * backoff. Timeouts (AbortError / TimeoutError) are not retried — a call that
 * already spent 60-90s waiting is not a transient failure worth repeating.
 * Rate limit errors (429) use a longer base delay (10s) to escape the quota
 * window. Streaming calls are intentionally excluded: retrying after chunks
 * have already been sent to the client would produce duplicate output.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const isTimeout =
        e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      if (isTimeout || i === maxAttempts - 1) throw e;
      // Rate limit errors need much longer backoff to escape the quota window
      const delayMs = isRateLimitError(e) ? 10_000 * (i + 1) : 1_000 * 2 ** i;
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

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

  private needsEnglishEnforcement(slug: string): boolean {
    return /qwen|deepseek/i.test(slug);
  }

  private enforceEnglish(system: string, slug: string): string {
    if (!this.needsEnglishEnforcement(slug)) return system;
    return system + "\n\nIMPORTANT: You MUST respond entirely in English. Never use Chinese or any other non-English language.";
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

    // 120s matches the completeResponse streaming path; Cerebras can be slow under load
    const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS ?? 120_000);

    const openStream = async (c: OpenAI, m: string) => {
      const effectiveSystem = this.enforceEnglish(system, slug);
      return c.chat.completions.create({
        model: m,
        max_tokens: 500,
        stream: true,
        stream_options: { include_usage: true },
        ...(this.seed !== undefined ? { seed: this.seed } : {}),
        messages: [{ role: "system", content: effectiveSystem }, ...promptMessages],
      }, { signal: AbortSignal.timeout(STREAM_TIMEOUT_MS) });
    };

    // Before any chunks are emitted we can safely fall back to OpenRouter on 429.
    let stream: Awaited<ReturnType<typeof openStream>>;
    let actualProviderKey = providerKey;
    let actualModel = model;
    try {
      stream = await openStream(client, model);
    } catch (e) {
      if ((isRateLimitError(e) || isTimeoutError(e)) && providerKey !== this.fallback) {
        const fallbackSlug = STANDARD_MODELS[resolvedRole];
        const { providerKey: fbKey, model: fbModel } = this.resolve(fallbackSlug);
        stream = await openStream(this.getClient(fbKey), fbModel);
        actualProviderKey = fbKey;
        actualModel = fbModel;
      } else {
        throw e;
      }
    }

    let fullResponse = "";
    let usage: OpenAIUsage | undefined;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) { fullResponse += delta; onChunk(delta); }
      if (chunk.usage) usage = chunk.usage as OpenAIUsage;
    }
    this.report(resolvedRole, actualProviderKey, actualModel, usage);
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

    const effectiveSystem = this.enforceEnglish(system, slug);
    const msgs = [
      { role: "system" as const, content: effectiveSystem },
      { role: "user" as const, content: userMessage },
    ];

    if (onChunk) {
      const createStream = (c: OpenAI, m: string) =>
        c.chat.completions.create({
          model: m,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(this.seed !== undefined ? { seed: this.seed } : {}),
          messages: msgs,
        }, { signal: AbortSignal.timeout(120_000) });

      let stream: Awaited<ReturnType<typeof createStream>>;
      let actualProviderKey = providerKey;
      let actualModel = model;
      try {
        stream = await createStream(client, model);
      } catch (e) {
        if (isRateLimitError(e) && providerKey !== this.fallback) {
          const fallbackSlug = STANDARD_MODELS[resolvedRole];
          const { providerKey: fbKey, model: fbModel } = this.resolve(fallbackSlug);
          stream = await createStream(this.getClient(fbKey), fbModel);
          actualProviderKey = fbKey;
          actualModel = fbModel;
        } else {
          throw e;
        }
      }

      let fullResponse = "";
      let usage: OpenAIUsage | undefined;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) { fullResponse += delta; onChunk(delta); }
        if (chunk.usage) usage = chunk.usage as OpenAIUsage;
      }
      this.report(resolvedRole, actualProviderKey, actualModel, usage);
      return fullResponse;
    }

    const callProvider = (c: OpenAI, m: string, pk: string) =>
      withRetry(async () => {
        const response = await c.chat.completions.create({
          model: m,
          max_tokens: maxTokens,
          ...(this.seed !== undefined ? { seed: this.seed } : {}),
          messages: msgs,
        }, { signal: AbortSignal.timeout(90_000) });
        this.report(resolvedRole, pk, m, response.usage as OpenAIUsage | undefined);
        const content = response.choices[0]?.message?.content;
        if (typeof content === "string") return content;
        throw new Error(`Unexpected response from ${pk}`);
      });

    try {
      return await callProvider(client, model, providerKey);
    } catch (e) {
      // When the primary provider (e.g. Cerebras) is still rate-limited after
      // all retry attempts, fall back to the OpenRouter standard model for this
      // role so the game continues instead of crashing.
      if (isRateLimitError(e) && providerKey !== this.fallback) {
        const fallbackSlug = STANDARD_MODELS[resolvedRole];
        const { providerKey: fbKey, model: fbModel } = this.resolve(fallbackSlug);
        return callProvider(this.getClient(fbKey), fbModel, fbKey);
      }
      throw e;
    }
  }

  async completeJson<T>(system: string, userMessage: string, role?: LLMRole, maxTokens = 1500): Promise<T> {
    return withRetry(async () => {
      const text = await this.completeResponse(system, userMessage, maxTokens, role);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");
      return JSON.parse(jsonMatch[0]) as T;
    });
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
