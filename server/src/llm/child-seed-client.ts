import type { LLMClient } from "./client.js";
import type { LLMRole, ModelTier } from "./model-config.js";
import { KID_ROLES, selectKidModel } from "./model-config.js";

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
 */
export class ChildSeedClient implements LLMClient {
  public kidModel: string | null = null;

  constructor(
    private readonly inner: LLMClient & { withModelOverride?: (model: string) => LLMClient },
    private readonly tier: ModelTier,
    public readonly gameId: string
  ) {}

  private async resolveKidModel(): Promise<string> {
    if (!this.kidModel) {
      this.kidModel = await selectKidModel(this.tier, this.gameId);
    }
    return this.kidModel;
  }

  private isKidRole(role?: LLMRole): boolean {
    return !!role && KID_ROLES.has(role);
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    if (this.isKidRole(role)) {
      const model = await this.resolveKidModel();
      const client =
        this.inner.withModelOverride?.(model) ?? this.inner;
      return client.streamResponse(system, messages, onChunk, role);
    }
    return this.inner.streamResponse(system, messages, onChunk, role);
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    if (this.isKidRole(role)) {
      const model = await this.resolveKidModel();
      const client =
        this.inner.withModelOverride?.(model) ?? this.inner;
      return client.completeResponse(system, userMessage, maxTokens, role, onChunk);
    }
    return this.inner.completeResponse(system, userMessage, maxTokens, role, onChunk);
  }

  async completeJson<T>(
    system: string,
    userMessage: string,
    role?: LLMRole,
    maxTokens?: number
  ): Promise<T> {
    if (this.isKidRole(role)) {
      const model = await this.resolveKidModel();
      const client =
        this.inner.withModelOverride?.(model) ?? this.inner;
      return client.completeJson<T>(system, userMessage, role, maxTokens);
    }
    return this.inner.completeJson<T>(system, userMessage, role, maxTokens);
  }
}
