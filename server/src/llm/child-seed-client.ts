import OpenAI from "openai";
import type { LLMClient } from "./client.js";
import type { KidModelSelection, LLMRole, ModelTier } from "./model-config.js";
import { KID_ROLES, selectKidModel } from "./model-config.js";
import { logger } from "../logger.js";

/**
 * True for the two failure modes the free-tier kid model can hit on
 * OpenRouter: it got rate limited (429), or it was removed from the catalog
 * (404). Both mean "this slug won't answer right now, but a different one
 * might" — worth one retry against the fallback slug. Anything else (a bad
 * prompt, a timeout, a 5xx) is not this kind of problem and should surface as
 * normal.
 */
function isRetryableModelError(e: unknown): boolean {
  return e instanceof OpenAI.RateLimitError || e instanceof OpenAI.NotFoundError;
}

/**
 * Wraps an LLMClient so kid roles use a model selected from the DB pool
 * based on the gameId. Non-kid roles pass through unchanged.
 *
 * The RoutingLLMClient underneath still handles provider routing, retries,
 * and failover — this wrapper only overrides WHICH model is selected for
 * kid calls, by resolving it before the inner client sees the role.
 *
 * Because RoutingLLMClient.streamResponse/completeResponse call
 * selectModel(role, tier) internally, we can't just pass a different role.
 * Instead, ChildSeedClient resolves the model slug and asks the inner
 * client to use it directly. This requires the inner client to support
 * model override — see the modelOverride parameter added to RoutingLLMClient.
 *
 * `selectKidModel` returns a { primary, fallback } pair rather than a single
 * slug: `primary` is the free tier when the pool entry has one, so most
 * calls run at zero marginal cost. But a free-tier slug can 429 (quota) or
 * 404 (delisted) with no warning, and the retry/failover logic that would
 * normally rescue a call lives in RoutingLLMClient at the role level — it
 * has no idea a "kid_family_chat" call is actually pinned to some rotating
 * free slug, so it can't fall back to the paid model for THIS slug. That
 * retry has to happen here, where the primary/fallback pair is known.
 */
export class ChildSeedClient implements LLMClient {
  /** The model slug actually used for the most recent kid call (primary, or fallback if it retried). */
  public kidModel: string | null = null;

  private selection: KidModelSelection | null = null;

  constructor(
    private readonly inner: LLMClient & { withModelOverride?: (model: string) => LLMClient },
    private readonly tier: ModelTier,
    public readonly gameId: string
  ) {}

  private async resolveKidModel(): Promise<KidModelSelection> {
    if (!this.selection) {
      this.selection = await selectKidModel(this.tier, this.gameId);
      this.kidModel = this.selection.primary;
    }
    return this.selection;
  }

  private isKidRole(role?: LLMRole): boolean {
    return !!role && KID_ROLES.has(role);
  }

  /**
   * Runs `call` against the pool-selected primary model. If it fails with a
   * 429 or 404 and a fallback slug exists, logs the fallback and retries once
   * against it. `canRetry` lets a caller veto the retry (e.g. a stream that
   * already emitted visible tokens under the primary model — retrying would
   * duplicate output the player already saw).
   */
  private async withKidModel<T>(
    role: LLMRole,
    call: (client: LLMClient) => Promise<T>,
    canRetry: () => boolean = () => true
  ): Promise<T> {
    const selection = await this.resolveKidModel();
    const primaryClient = this.inner.withModelOverride?.(selection.primary) ?? this.inner;
    try {
      return await call(primaryClient);
    } catch (e) {
      if (!selection.fallback || !isRetryableModelError(e) || !canRetry()) {
        throw e;
      }
      logger.warn("kid_model_fallback", {
        gameId: this.gameId,
        role,
        from: selection.primary,
        to: selection.fallback,
        reason: e instanceof OpenAI.RateLimitError ? "rate_limit" : "not_found",
      });
      this.kidModel = selection.fallback;
      const fallbackClient = this.inner.withModelOverride?.(selection.fallback) ?? this.inner;
      return call(fallbackClient);
    }
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    if (!this.isKidRole(role)) {
      return this.inner.streamResponse(system, messages, onChunk, role);
    }
    let emittedAny = false;
    const trackedOnChunk = (chunk: string) => {
      emittedAny = true;
      onChunk(chunk);
    };
    return this.withKidModel(
      role!,
      (client) => client.streamResponse(system, messages, trackedOnChunk, role),
      () => !emittedAny
    );
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    if (!this.isKidRole(role)) {
      return this.inner.completeResponse(system, userMessage, maxTokens, role, onChunk);
    }
    let emittedAny = false;
    const trackedOnChunk = onChunk
      ? (chunk: string) => {
          emittedAny = true;
          onChunk(chunk);
        }
      : undefined;
    return this.withKidModel(
      role!,
      (client) => client.completeResponse(system, userMessage, maxTokens, role, trackedOnChunk),
      () => !emittedAny
    );
  }

  async completeJson<T>(
    system: string,
    userMessage: string,
    role?: LLMRole,
    maxTokens?: number
  ): Promise<T> {
    if (!this.isKidRole(role)) {
      return this.inner.completeJson<T>(system, userMessage, role, maxTokens);
    }
    return this.withKidModel(role!, (client) =>
      client.completeJson<T>(system, userMessage, role, maxTokens)
    );
  }
}
