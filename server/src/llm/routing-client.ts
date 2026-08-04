import OpenAI from "openai";
import { REQUEST_TIMEOUT_MS, type LLMClient, type LLMUsage, type UsageSink } from "./client.js";
import { type LLMRole, type ModelTier, budgetFor, estimateCostUsd, selectModel, STANDARD_MODELS } from "./model-config.js";
import { logger } from "../logger.js";

function isRateLimitError(e: unknown): boolean {
  return e instanceof OpenAI.RateLimitError;
}

/**
 * Model family used when the primary answers HTTP 200 with no content.
 * Must be a DIFFERENT family from the qwen models most roles use — falling back
 * to STANDARD_MODELS is useless here, since for these roles that is the same
 * qwen model that just returned nothing.
 */
export const EMPTY_CONTENT_FAILOVER_MODEL = "deepseek/deepseek-v4-flash";

/** The error callProvider throws when a provider returns a non-string content. */
function isEmptyContentError(e: unknown): boolean {
  return e instanceof Error && /^Unexpected response from /.test(e.message);
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/**
 * Retry a non-streaming LLM call up to maxAttempts times with exponential
 * backoff. Timeouts (AbortError / TimeoutError) are not retried — a call that
 * already spent 60-90s waiting is not a transient failure worth repeating.
 * Empty-content responses are not retried either, for the same reason: the
 * fault is deterministic, so all three attempts come back equally empty while
 * the player waits. Both cases are surfaced immediately so completeResponse can
 * fail over to a different model family.
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
      // A model that answered 200 with no content will answer the same way
      // again — retrying only makes the player wait through it and bills us for
      // another empty response. Same reasoning as timeouts: surface it
      // immediately so the caller can fail over to a different model family.
      if (isTimeoutError(e) || isEmptyContentError(e) || i === maxAttempts - 1) throw e;
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

    // Cerebras can be slow under load; STREAM_TIMEOUT_MS stays overridable on its own.
    const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS ?? REQUEST_TIMEOUT_MS);

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
          max_tokens: budgetFor(m, maxTokens),
          stream: true,
          stream_options: { include_usage: true },
          ...(this.seed !== undefined ? { seed: this.seed } : {}),
          messages: msgs,
        }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

      /**
       * One attempt: open the stream (falling back on rate limit) and drain it.
       * `emittedAny` is deliberately OUTSIDE this closure — see the retry loop.
       */
      const attemptStream = async (c: OpenAI, m: string, pk: string): Promise<string> => {
        let stream: Awaited<ReturnType<typeof createStream>>;
        let actualProviderKey = pk;
        let actualModel = m;
        try {
          stream = await createStream(c, m);
        } catch (e) {
          if (isRateLimitError(e) && pk !== this.fallback) {
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
        let finishReason: string | null | undefined;
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            fullResponse += delta;
            emittedAny = true;
            onChunk(delta);
          }
          if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          if (chunk.usage) usage = chunk.usage as OpenAIUsage;
        }
        this.report(resolvedRole, actualProviderKey, actualModel, usage);
        this.reportTruncation(resolvedRole, actualModel, finishReason, usage);
        /**
         * A stream that carried no content at all is the streaming form of
         * `content: null` — a reasoning model that spent its entire budget
         * thinking emits zero content deltas. Returning "" here handed the
         * player silence with no error and no log line, which is why the
         * production logs showed empty responses only for the roles that happen
         * not to stream. Raise it so the empty-content failover can catch it.
         */
        if (fullResponse === "") throw new Error(`Unexpected response from ${actualProviderKey}`);
        return fullResponse;
      };

      /**
       * Retry a stream that died BEFORE the player saw anything.
       *
       * The non-streaming path has always retried via withRetry; the streaming
       * path had no retry at all, so a single upstream hiccup mid-iteration went
       * straight to the player as a failed message. Seen in production twice:
       * "Upstream error from Alibaba: Output data may contain inappropriate
       * content" (2026-08-03 11:51:15Z) and "JSON error injected into SSE
       * stream" (17:50:59Z), both thrown out of the OpenAI SDK's stream
       * iterator during handleParentMessage.
       *
       * The `emittedAny` guard is the whole safety property: once a single token
       * has reached the player, replaying the call would duplicate visible text
       * mid-sentence, so we surface the error instead. Timeouts are not retried,
       * matching withRetry — a slow response would only be slow again.
       */
      let emittedAny = false;
      const MAX_STREAM_ATTEMPTS = 3;
      const streamWithRetries = async (c: OpenAI, m: string, pk: string): Promise<string> => {
        let lastStreamError: unknown;
        for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
          try {
            return await attemptStream(c, m, pk);
          } catch (e) {
            lastStreamError = e;
            // Empty content joins timeouts as non-retryable: the same model will
            // reason its budget away again. Fail over instead.
            if (
              emittedAny ||
              isTimeoutError(e) ||
              isEmptyContentError(e) ||
              attempt === MAX_STREAM_ATTEMPTS - 1
            ) {
              throw e;
            }
            await new Promise<void>((r) => setTimeout(r, 1_000 * 2 ** attempt));
          }
        }
        throw lastStreamError;
      };

      try {
        return await streamWithRetries(client, model, providerKey);
      } catch (e) {
        /**
         * `!emittedAny` is what makes re-running legal: no token has reached the
         * player, so there is no visible text to duplicate. Once the player has
         * seen anything, we surface the error instead.
         */
        if (isEmptyContentError(e) && !emittedAny && model !== EMPTY_CONTENT_FAILOVER_MODEL) {
          const { providerKey: fbKey, model: fbModel } = this.resolve(EMPTY_CONTENT_FAILOVER_MODEL);
          logger.warn("llm_empty_content_failover", {
            role: resolvedRole,
            from: model,
            to: fbModel,
            streaming: true,
          });
          return streamWithRetries(this.getClient(fbKey), fbModel, fbKey);
        }
        throw e;
      }
    }

    const callProvider = (c: OpenAI, m: string, pk: string) =>
      withRetry(async () => {
        const response = await c.chat.completions.create({
          model: m,
          max_tokens: budgetFor(m, maxTokens),
          ...(this.seed !== undefined ? { seed: this.seed } : {}),
          messages: msgs,
        }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        this.report(resolvedRole, pk, m, response.usage as OpenAIUsage | undefined);
        this.reportTruncation(resolvedRole, m, response.choices[0]?.finish_reason, response.usage as OpenAIUsage | undefined);
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
      // A model answering HTTP 200 with `content: null` is a provider-side
      // fault, not a transient one — withRetry burns all three attempts and
      // every one comes back empty. Reproduced against OpenRouter on
      // 2026-08-04 with a 32-token "Say OK.": qwen3.7-max and qwen3.7-plus both
      // returned 200 / content null while deepseek answered normally. Eleven of
      // this game's roles sit on those two models, so new games could not seed
      // a child, scenes could not end, and no epilogue could be written.
      //
      // Fail over to a different model FAMILY, which is the only thing that
      // helps here (STANDARD_MODELS for these roles is the same qwen model).
      // This is a circuit breaker, not a downgrade: it engages only when the
      // primary has produced nothing at all, and stops engaging the moment the
      // primary recovers — a degraded scene beats an error where the scene
      // should have been.
      if (isEmptyContentError(e) && model !== EMPTY_CONTENT_FAILOVER_MODEL) {
        const { providerKey: fbKey, model: fbModel } = this.resolve(EMPTY_CONTENT_FAILOVER_MODEL);
        logger.warn("llm_empty_content_failover", {
          role: resolvedRole,
          from: model,
          to: fbModel,
        });
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

  /**
   * `finish_reason: "length"` means the model was cut off, not that it finished.
   * The text that comes back is real but partial, so nothing downstream can tell
   * the difference — a JSON role fails to parse for no visible reason and a
   * prose role ships a mid-sentence cutoff to the player. Log it so the next
   * occurrence is diagnosable and REASONING_TOKEN_ALLOWANCE can be tuned against
   * evidence rather than guessed at again.
   */
  private reportTruncation(
    role: LLMRole,
    model: string,
    finishReason: string | null | undefined,
    usage: OpenAIUsage | undefined
  ): void {
    if (finishReason !== "length") return;
    logger.warn("llm_truncated", {
      role,
      model,
      outputTokens: usage?.completion_tokens ?? null,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
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
  /** Present on reasoning models; the share of completion_tokens spent thinking. */
  completion_tokens_details?: { reasoning_tokens?: number };
};
