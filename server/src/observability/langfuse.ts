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
 *
 * Privacy: a `baseUrl` (self-hosted Langfuse) is REQUIRED to activate tracing
 * — see `getLangfuseClient`. Traces also carry parent confessional text
 * (embedded in the `personality_seed` prompt); that text is redacted before
 * being sent, see `redactConfessionalText`/`CONFESSIONAL_ROLES` below.
 */
import { Langfuse } from "langfuse";
import type { LLMClient } from "../llm/client.js";
import { type LLMRole, type ModelTier, selectModel } from "../llm/model-config.js";
import { ChildSeedClient } from "../llm/child-seed-client.js";
import { CHILD_SAFETY_HOLD_TAG, isGameHeldInProcess } from "./child-safety-exclusion.js";
import { HOSTED_NO_ANALYSIS_TAG, isGameHosted } from "./hosted-analysis.js";
import { PRESSURE_POINT_HEADER, PRESSURE_POINT_OPEN, PRESSURE_POINT_CLOSE } from "../game/pressure-point.js";
import { currentGameId } from "./trace-context.js";
import { captureException } from "./sentry.js";
import { devTraceFile } from "../dev/harness.js";
import { FileTraceSink } from "../dev/trace-file-sink.js";
import { logger } from "../logger.js";

/**
 * Metadata carried by a traced client. Used both for trace tags
 * (game_id, event_number, llm_role) and as structured trace metadata.
 */
export interface TraceMetadata {
  gameId?: string;
  eventNumber?: number;
  /** Logical LLM role: "kid" | "world_manager" | "psychologist" | "epilogue" | "report_card". */
  role?: string;
  /** The pool-selected model actually used for this call, when it went through
   * a ChildSeedClient kid-role rotation. Absent for non-kid roles and for
   * calls made before the first kid model has been resolved. */
  kidModel?: string;
}

/**
 * What TracedLLMClient and holdGameTraces use of the Langfuse SDK: the real
 * client, or, in local dev only, the RI_DEV_TRACE_FILE capture sink.
 */
export interface TraceSink {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trace(body: { id?: string; name?: string; tags?: string[]; metadata?: any }): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generation(body: any): { end(body?: any): unknown };
  };
  flushAsync(): Promise<void>;
}

let cachedClient: TraceSink | null = null;
let initialized = false;

/**
 * Returns a singleton Langfuse client, or `null` when the required env vars
 * are absent. Initialization happens lazily on first call so that importing
 * this module has no side effects.
 *
 * Required env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and one of
 * LANGFUSE_BASEURL / LANGFUSE_HOST.
 *
 * `baseUrl` is deliberately REQUIRED, not optional: the Langfuse SDK defaults
 * to `https://cloud.langfuse.com` when no baseUrl is given, which would send
 * traces — including confessional-derived prompts — to a third-party cloud
 * with no retention/DPA guarantees (issue #140). Point it at the self-hosted
 * instance (see `langfuse/docker-compose.yml`) to enable tracing.
 */
export function getLangfuseClient(): TraceSink | null {
  if (initialized) return cachedClient;
  initialized = true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASEURL ?? process.env.LANGFUSE_HOST;

  if (!publicKey || !secretKey || !baseUrl) {
    // Local dev only (refused in production): capture to a file instead.
    const file = devTraceFile();
    cachedClient = file ? new FileTraceSink(file) : null;
    return cachedClient;
  }

  cachedClient = new Langfuse({ publicKey, secretKey, baseUrl });
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

/**
 * Roles whose prompt embeds raw parent confessional text (see
 * `game/personality.ts:generatePersonalitySeed`). Their traced `input` is
 * redacted before being sent to Langfuse — see `redactConfessionalText`.
 */
const CONFESSIONAL_ROLES = new Set<LLMRole>(["personality_seed"]);

const CONFESSIONAL_HEADER = "Emotional themes from parent confessionals:\n";
const CONFESSIONAL_TRAILER = "\n\nGenerate the personality seed";

/**
 * Replaces every `Parent N: "<confessional text>"` span with a length-only
 * placeholder, so the shape of the prompt is still visible in a trace
 * without shipping the confessional's actual content to Langfuse.
 *
 * Fails closed: confessionals are free text and may contain quotes and
 * newlines, so a span is NOT delimited by the next `"`. The whole section,
 * from the header (or the first `Parent N: "` label) to the prompt's trailer
 * (or the end of the text), is redacted; it is only split back into
 * per-parent spans at line starts that begin a new label.
 */
function redactConfessionalText(text: string): string {
  const headerAt = text.indexOf(CONFESSIONAL_HEADER);
  const firstLabel = text.search(/Parent \d: "/);
  if (headerAt === -1 && firstLabel === -1) return text;
  const start = headerAt !== -1 ? headerAt + CONFESSIONAL_HEADER.length : firstLabel;
  const trailerAt = text.lastIndexOf(CONFESSIONAL_TRAILER);
  const end = trailerAt >= start ? trailerAt : text.length;
  const redacted = text
    .slice(start, end)
    .split(/\n(?=Parent \d: ")/)
    .map((span) => {
      const m = /^(Parent \d: )"([\s\S]*?)"?$/.exec(span);
      return m ? `${m[1]}"[redacted, ${m[2].length} chars]"` : `[redacted, ${span.length} chars]`;
    })
    .join("\n");
  return text.slice(0, start) + redacted + text.slice(end);
}

/** Redacts `text` when `role` is known to carry confessional content. */
function redactIfConfessional(role: LLMRole | undefined, text: string): string {
  return role && CONFESSIONAL_ROLES.has(role) ? redactConfessionalText(text) : text;
}

/**
 * The world manager's prompt can carry one parent confessional, verbatim, in
 * its "pressure point" section (context-assembler.ts buildLandmineSection).
 * Whatever the role, a traced system prompt never keeps it: everything from
 * the section's opening line to its closing line goes. Fails closed: with no
 * opening line, from the header; with no closing line, to the end.
 */
function redactPressurePoint(text: string): string {
  const header = text.indexOf(PRESSURE_POINT_HEADER);
  if (header === -1) return text;
  const open = text.indexOf(PRESSURE_POINT_OPEN, header);
  const start = open !== -1 ? open + PRESSURE_POINT_OPEN.length : header + PRESSURE_POINT_HEADER.length;
  const close = text.indexOf(PRESSURE_POINT_CLOSE, start);
  const end = close !== -1 ? close : text.length;
  return `${text.slice(0, start)}\n\n[redacted, ${end - start} chars]\n\n${text.slice(end)}`;
}

/**
 * Exported for tests only — exercises the redaction regex directly without
 * needing a configured Langfuse client.
 * @internal
 */
export function __redactConfessionalTextForTests(text: string): string {
  return redactConfessionalText(text);
}

function buildTags(metadata: TraceMetadata): string[] {
  const tags: string[] = [];
  if (metadata.gameId) tags.push(`game_id:${metadata.gameId}`);
  if (metadata.eventNumber !== undefined) tags.push(`event_number:${metadata.eventNumber}`);
  if (metadata.role) tags.push(`llm_role:${metadata.role}`);
  if (isGameHeldInProcess(metadata.gameId)) tags.push(CHILD_SAFETY_HOLD_TAG);
  if (isGameHosted(metadata.gameId)) tags.push(HOSTED_NO_ANALYSIS_TAG);
  return tags;
}

/**
 * A trace that names no game can't be tagged `hosted_no_analysis` or
 * `child_safety_hold`, so no reader could ever drop it. Such a trace is never
 * sent (fail closed), and the refusal is reported so the missing context gets
 * fixed. Every LLM role in RI is game-scoped.
 */
function refuseTrace(msg: string, fields: Record<string, unknown>): void {
  logger.error(msg, fields);
  captureException(new Error(msg), { tags: { component: "langfuse", role: String(fields.role ?? "") } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Generation = { end: (args: any) => unknown };

/**
 * Decorates any `LLMClient`, wrapping each call in a Langfuse trace +
 * generation. When Langfuse is unconfigured, every method delegates directly
 * to the inner client with zero observable difference.
 *
 * Every trace names its game: from this client's metadata (withContext,
 * withChildSeed) or, for the app's shared client, from the async context the
 * request or socket event set up (observability/trace-context.ts). A call with
 * neither, or with two different games, is not traced at all (`scope`).
 */
export class TracedLLMClient implements LLMClient {
  constructor(
    private readonly inner: LLMClient,
    private readonly metadata: TraceMetadata = {},
    private readonly tier?: ModelTier
  ) {}

  /**
   * Returns a *new* TracedLLMClient carrying merged metadata. Tags on the
   * resulting traces include game_id, event_number, and llm_role. The
   * underlying inner client is shared (decorators are cheap and stateless).
   */
  withContext(metadata: TraceMetadata): TracedLLMClient {
    return new TracedLLMClient(this.inner, { ...this.metadata, ...metadata }, this.tier);
  }

  /**
   * Returns a ChildSeedClient that rotates kid models for this gameId, drawn
   * from the DB pool for `this.tier`. Non-kid roles pass through to a
   * TracedLLMClient scoped to the same game, so every trace it makes names it.
   */
  withChildSeed(gameId: string): ChildSeedClient {
    const tier = this.tier ?? "standard";
    return new ChildSeedClient(this.withContext({ gameId }), tier, gameId);
  }

  /**
   * Returns a new TracedLLMClient wrapping the inner client's model override,
   * carrying `kidModel: model` in its metadata.
   *
   * This is how kid-model rotation actually reaches Langfuse. ChildSeedClient
   * wraps a TracedLLMClient (not the other way around — see child-seed-client.ts),
   * so an `instanceof ChildSeedClient` check inside TracedLLMClient's own
   * streamResponse/completeResponse can never be true; that check used to sit
   * here and silently never fire, leaving every trace's `kidModel` field empty.
   * Stamping the resolved model into metadata at override time — the one place
   * ChildSeedClient and TracedLLMClient actually touch — means the traces
   * produced by calls on the returned client already carry it, with no runtime
   * type check required.
   */
  withModelOverride(model: string): LLMClient {
    if (typeof (this.inner as any).withModelOverride === "function") {
      return new TracedLLMClient(
        (this.inner as any).withModelOverride(model),
        { ...this.metadata, kidModel: model },
        this.tier
      );
    }
    return this;
  }

  private resolveModel(role?: LLMRole): string | undefined {
    // A client returned by withModelOverride() sends every call to that model
    // (RoutingLLMClient's _modelOverride), so report it — not the role default.
    // Before this, every rotated kid voice was logged (and priced) as the
    // default kid model, with the real one only in metadata.kidModel.
    if (this.metadata.kidModel) return this.metadata.kidModel;
    if (!this.tier || !role) return undefined;
    try { return selectModel(role, this.tier); } catch { return undefined; }
  }

  /**
   * The metadata for this call's trace, with its game, or null when it must
   * not be traced: no game anywhere, or this client's game and the async
   * context's game disagree (a client scoped to one game used while working
   * for another, which would file one game's text under the other's id).
   */
  private scope(role?: LLMRole): TraceMetadata | null {
    const metadata = this.mergeRole(role);
    const fromContext = currentGameId();
    if (metadata.gameId && fromContext && metadata.gameId !== fromContext) {
      refuseTrace("llm_trace_refused_game_mismatch", { role: metadata.role, clientGameId: metadata.gameId, contextGameId: fromContext });
      return null;
    }
    const gameId = metadata.gameId ?? fromContext;
    if (!gameId) {
      refuseTrace("llm_trace_refused_no_game_id", { role: metadata.role });
      return null;
    }
    return { ...metadata, gameId };
  }

  /** Opens this call's trace and generation, or returns undefined when it isn't traced. `input` is built only when it is. */
  private start(call: string, role: LLMRole | undefined, input: () => unknown, extra: Record<string, unknown> = {}): Generation | undefined {
    const client = getLangfuseClient();
    if (!client) return undefined;
    const metadata = this.scope(role);
    if (!metadata) return undefined;
    const model = this.resolveModel(role);
    try {
      const trace = client.trace({
        name: this.traceName(call, role),
        tags: buildTags(metadata),
        metadata: { ...metadata },
      });
      return trace.generation({
        name: metadata.role ?? "llm",
        input: input(),
        ...(model ? { model } : {}),
        metadata: { ...metadata, ...extra },
      });
    } catch {
      // Langfuse SDK error — continue without tracing
      return undefined;
    }
  }

  private async finish<T>(generation: Generation | undefined, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      generation?.end({ output: result });
      return result;
    } catch (err) {
      generation?.end({ output: { error: String(err) }, level: "ERROR" });
      throw err;
    }
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    const generation = this.start("stream", role, () => ({
      system: redactPressurePoint(system),
      messages: messages.map((m) => ({ ...m, content: redactIfConfessional(role, m.content) })),
    }));
    return this.finish(generation, () => this.inner.streamResponse(system, messages, onChunk, role));
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const generation = this.start(
      "complete",
      role,
      () => ({ system: redactPressurePoint(system), userMessage: redactIfConfessional(role, userMessage) }),
      { maxTokens },
    );
    return this.finish(generation, () => this.inner.completeResponse(system, userMessage, maxTokens, role, onChunk));
  }

  async completeJson<T>(system: string, userMessage: string, role?: LLMRole, maxTokens?: number): Promise<T> {
    const generation = this.start("complete_json", role, () => ({
      system: redactPressurePoint(system),
      userMessage: redactIfConfessional(role, userMessage),
    }));
    return this.finish(generation, () => this.inner.completeJson<T>(system, userMessage, role, maxTokens));
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

/**
 * The app's one model client: `inner` (the real router, or the dev harness's
 * canned model) behind the tracer. index.ts builds it with this, and the
 * production-path tests build theirs with it too, so the canned model's calls
 * are traced and tagged exactly like real ones.
 */
export function traceAppLlm(inner: LLMClient, tier: ModelTier): TracedLLMClient {
  return new TracedLLMClient(inner, {}, tier);
}
