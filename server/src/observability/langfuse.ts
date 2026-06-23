/**
 * Langfuse observability layer (Milestone 6, Task 20).
 *
 * Provides a lazily-initialized Langfuse client and a `TracedLLMClient`
 * decorator that wraps any `LLMClient` so every LLM call is recorded as a
 * Langfuse generation under a trace tagged with game/event/role metadata.
 *
 * Design goal: tracing is *fully optional*. If the Langfuse environment
 * variables are not set, the client is never constructed and the decorator
 * becomes a transparent pass-through — identical behavior, no network calls.
 * This keeps local development frictionless when no Langfuse keys are present.
 */
import { Langfuse } from "langfuse";
import type { LLMClient } from "../llm/client.js";
import type { LLMRole } from "../llm/model-config.js";

/**
 * Metadata carried by a traced client. Used both for trace tags
 * (game_id, event_number, llm_role) and as structured trace metadata.
 */
export interface TraceMetadata {
  gameId?: string;
  eventNumber?: number;
  /** Logical LLM role: "kid" | "world_manager" | "psychologist" | "epilogue" | "report_card". */
  role?: string;
}

let cachedClient: Langfuse | null = null;
let initialized = false;

/**
 * Returns a singleton Langfuse client, or `null` when the required env vars
 * are absent. Initialization happens lazily on first call so that importing
 * this module has no side effects.
 *
 * Required env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY.
 * Optional env: LANGFUSE_BASEURL (defaults to Langfuse cloud).
 */
export function getLangfuseClient(): Langfuse | null {
  if (initialized) return cachedClient;
  initialized = true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASEURL;

  if (!publicKey || !secretKey) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = new Langfuse({
    publicKey,
    secretKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
  return cachedClient;
}

/** True when Langfuse is configured and tracing will be active. */
export function isLangfuseEnabled(): boolean {
  return getLangfuseClient() !== null;
}

/**
 * Flushes any buffered events to Langfuse. No-op when unconfigured. Call on
 * graceful shutdown so in-flight traces are not lost.
 */
export async function flushLangfuse(): Promise<void> {
  await cachedClient?.flushAsync();
}

/**
 * Resets the cached client. Intended for tests so env changes take effect.
 * @internal
 */
export function __resetLangfuseClientForTests(): void {
  cachedClient = null;
  initialized = false;
}

function buildTags(metadata: TraceMetadata): string[] {
  const tags: string[] = [];
  if (metadata.gameId) tags.push(`game_id:${metadata.gameId}`);
  if (metadata.eventNumber !== undefined) tags.push(`event_number:${metadata.eventNumber}`);
  if (metadata.role) tags.push(`llm_role:${metadata.role}`);
  return tags;
}

/**
 * Decorates any `LLMClient`, wrapping each call in a Langfuse trace +
 * generation. When Langfuse is unconfigured, every method delegates directly
 * to the inner client with zero observable difference.
 */
export class TracedLLMClient implements LLMClient {
  constructor(
    private readonly inner: LLMClient,
    private readonly metadata: TraceMetadata = {}
  ) {}

  /**
   * Returns a *new* TracedLLMClient carrying merged metadata. Tags on the
   * resulting traces include game_id, event_number, and llm_role. The
   * underlying inner client is shared (decorators are cheap and stateless).
   */
  withContext(metadata: TraceMetadata): TracedLLMClient {
    return new TracedLLMClient(this.inner, { ...this.metadata, ...metadata });
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    const metadata = this.mergeRole(role);
    const client = getLangfuseClient();
    if (!client) {
      return this.inner.streamResponse(system, messages, onChunk, role);
    }

    const trace = client.trace({
      name: this.traceName("stream", role),
      tags: buildTags(metadata),
      metadata: { ...metadata },
    });
    const generation = trace.generation({
      name: metadata.role ?? "llm",
      input: { system, messages },
      metadata: { ...metadata },
    });

    try {
      const result = await this.inner.streamResponse(system, messages, onChunk, role);
      generation.end({ output: result });
      return result;
    } catch (err) {
      generation.end({ output: { error: String(err) }, level: "ERROR" });
      throw err;
    }
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const metadata = this.mergeRole(role);
    const client = getLangfuseClient();
    if (!client) {
      return this.inner.completeResponse(system, userMessage, maxTokens, role, onChunk);
    }

    const trace = client.trace({
      name: this.traceName("complete", role),
      tags: buildTags(metadata),
      metadata: { ...metadata },
    });
    const generation = trace.generation({
      name: metadata.role ?? "llm",
      input: { system, userMessage },
      metadata: { ...metadata, maxTokens },
    });

    try {
      const result = await this.inner.completeResponse(system, userMessage, maxTokens, role, onChunk);
      generation.end({ output: result });
      return result;
    } catch (err) {
      generation.end({ output: { error: String(err) }, level: "ERROR" });
      throw err;
    }
  }

  async completeJson<T>(system: string, userMessage: string, role?: LLMRole): Promise<T> {
    const metadata = this.mergeRole(role);
    const client = getLangfuseClient();
    if (!client) {
      return this.inner.completeJson<T>(system, userMessage, role);
    }

    const trace = client.trace({
      name: this.traceName("complete_json", role),
      tags: buildTags(metadata),
      metadata: { ...metadata },
    });
    const generation = trace.generation({
      name: metadata.role ?? "llm",
      input: { system, userMessage },
      metadata: { ...metadata },
    });

    try {
      const result = await this.inner.completeJson<T>(system, userMessage, role);
      generation.end({ output: result });
      return result;
    } catch (err) {
      generation.end({ output: { error: String(err) }, level: "ERROR" });
      throw err;
    }
  }

  /** Per-call role (model-config) takes precedence over the context role for
   * trace tagging, so traces reflect the exact model that was selected. */
  private mergeRole(role?: LLMRole): TraceMetadata {
    return role ? { ...this.metadata, role } : this.metadata;
  }

  private traceName(call: string, role?: LLMRole): string {
    const name = role ?? this.metadata.role ?? "llm";
    return `${name}.${call}`;
  }
}
