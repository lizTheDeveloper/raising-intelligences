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
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const client = getLangfuseClient();
    if (!client) {
      return this.inner.streamResponse(system, messages, onChunk);
    }

    const trace = client.trace({
      name: this.traceName("stream"),
      tags: buildTags(this.metadata),
      metadata: { ...this.metadata },
    });
    const generation = trace.generation({
      name: this.metadata.role ?? "llm",
      input: { system, messages },
      metadata: { ...this.metadata },
    });

    try {
      const result = await this.inner.streamResponse(system, messages, onChunk);
      generation.end({ output: result });
      return result;
    } catch (err) {
      generation.end({ output: { error: String(err) }, level: "ERROR" });
      throw err;
    }
  }

  async completeResponse(system: string, userMessage: string, maxTokens?: number): Promise<string> {
    const client = getLangfuseClient();
    if (!client) {
      return this.inner.completeResponse(system, userMessage, maxTokens);
    }

    const trace = client.trace({
      name: this.traceName("complete"),
      tags: buildTags(this.metadata),
      metadata: { ...this.metadata },
    });
    const generation = trace.generation({
      name: this.metadata.role ?? "llm",
      input: { system, userMessage },
      metadata: { ...this.metadata, maxTokens },
    });

    try {
      const result = await this.inner.completeResponse(system, userMessage, maxTokens);
      generation.end({ output: result });
      return result;
    } catch (err) {
      generation.end({ output: { error: String(err) }, level: "ERROR" });
      throw err;
    }
  }

  async completeJson<T>(system: string, userMessage: string): Promise<T> {
    const client = getLangfuseClient();
    if (!client) {
      return this.inner.completeJson<T>(system, userMessage);
    }

    const trace = client.trace({
      name: this.traceName("complete_json"),
      tags: buildTags(this.metadata),
      metadata: { ...this.metadata },
    });
    const generation = trace.generation({
      name: this.metadata.role ?? "llm",
      input: { system, userMessage },
      metadata: { ...this.metadata },
    });

    try {
      const result = await this.inner.completeJson<T>(system, userMessage);
      generation.end({ output: result });
      return result;
    } catch (err) {
      generation.end({ output: { error: String(err) }, level: "ERROR" });
      throw err;
    }
  }

  private traceName(call: string): string {
    const role = this.metadata.role ?? "llm";
    return `${role}.${call}`;
  }
}
