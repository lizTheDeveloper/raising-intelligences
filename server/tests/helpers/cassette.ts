import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { LLMClient } from "../../src/llm/client.js";
import type { LLMRole } from "../../src/llm/model-config.js";

/**
 * Record/replay caching layer for the LLM provider — a "VCR cassette" for the
 * integration and E2E suites.
 *
 * The point of these tests is to drive the *real* system (express, socket.io,
 * the engines, the state machine, the repository) through a full playthrough
 * without mocking any of it. The one thing we cannot make deterministic for
 * free is the model provider, so we record its responses once against real
 * OpenRouter (with a fixed seed, so the calls are reproducible and hit
 * OpenRouter's own prompt cache) and replay them deterministically thereafter.
 *
 * Cache keys are a hash of (method, role, seed, system, prompt), so identical
 * inputs map to identical recorded outputs. Because the scripted parent
 * messages, the child name, and the seed are fixed, every downstream prompt —
 * which depends on earlier recorded outputs — is also stable, and the whole
 * playthrough replays byte-for-byte.
 *
 * Modes (LLM_CACHE_MODE):
 *   - "replay" (default): every call must hit the cassette; a miss throws with
 *     instructions to re-record. No network. This is what CI runs.
 *   - "record": always call the wrapped client and (over)write the cassette.
 *   - "auto": replay on hit, otherwise call through and append to the cassette.
 */
export type CassetteMode = "replay" | "record" | "auto";

type Method = "stream" | "complete" | "json";

interface CassetteEntry {
  method: Method;
  role?: LLMRole;
  /** Human-readable preview of the request, for debugging the cassette file. */
  preview: string;
  /** Recorded output: string for stream/complete, any JSON for json. */
  value: unknown;
}

type CassetteFile = Record<string, CassetteEntry>;

export interface CassetteOptions {
  /** Absolute path to the cassette JSON file. */
  file: string;
  mode?: CassetteMode;
  /** Seed mixed into every cache key so re-recordings with a new seed don't
   * collide with old ones. Should match the seed given to the real client. */
  seed?: number;
}

export class CassetteLLMClient implements LLMClient {
  private readonly file: string;
  private readonly mode: CassetteMode;
  private readonly seed?: number;
  private store: CassetteFile;
  /** Number of calls served from the cassette vs. recorded — handy in assertions. */
  public replays = 0;
  public records = 0;
  /** Record calls still running (e.g. a fire-and-forget prefetch). Drained by
   * `waitInFlight()` so a run can't exit and orphan a half-recorded cassette. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly inner: LLMClient, options: CassetteOptions) {
    this.file = options.file;
    this.mode = options.mode ?? "replay";
    this.seed = options.seed;
    this.store =
      existsSync(this.file) && this.mode !== "record"
        ? (JSON.parse(readFileSync(this.file, "utf8")) as CassetteFile)
        : {};
  }

  private key(method: Method, role: LLMRole | undefined, prompt: string): string {
    const payload = JSON.stringify({ method, role, seed: this.seed, prompt });
    return createHash("sha256").update(payload).digest("hex").slice(0, 32);
  }

  private miss(method: Method, role: LLMRole | undefined): never {
    throw new Error(
      `[cassette] No recorded ${method} response (role=${role}) in ${path.basename(
        this.file
      )}. Re-record with: LLM_CACHE_MODE=record LLM_SEED=${this.seed} npm test -w server`
    );
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.store, null, 2) + "\n");
  }

  /** Register a live record call so `waitInFlight()` can drain it. Fire-and-forget
   * calls (e.g. the endChat scene prefetch) run concurrently and would otherwise
   * still be in flight when the run exits, leaving a hole in the cassette. */
  private track<T>(p: Promise<T>): Promise<T> {
    if (this.mode !== "record") return p;
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }

  /** Resolve once every in-flight record call has settled (no-op in replay). */
  async waitInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Bounded retries when the live provider answers with nothing usable
   * during recording. */
  private static readonly RECORD_RETRIES = 5;

  /**
   * In record mode the live provider occasionally misbehaves in ways that
   * must not be baked into the cassette:
   *
   * - empty content — a documented OpenRouter failure mode (see
   *   tests/empty-content-failover.test.ts), most visible on the rotating
   *   kid models' long prompts. An empty entry replays as nothing and fails
   *   the assertion it was supposed to back.
   * - a thrown error (timeout abort, 5xx, malformed JSON) — a non-fatal
   *   live call that fails only once must not leave a hole in the cassette
   *   that replay then trips over; and a fatal one is usually transient too.
   *
   * So re-ask a bounded number of times, only giving up (empty string, or the
   * last error) once every attempt has failed. Replay never reaches this path:
   * the cassette is the source of truth there.
   */
  private async recordWithRetries(label: string, call: () => Promise<string>): Promise<string> {
    let text = "";
    for (let attempt = 0; ; attempt++) {
      try {
        text = await call();
      } catch (e) {
        if (attempt >= CassetteLLMClient.RECORD_RETRIES) throw e;
        // eslint-disable-next-line no-console
        console.log(`[cassette] ${label} failed (attempt ${attempt + 1}): ${(e as Error).message}; re-asking the provider`);
        continue;
      }
      if (text.trim() !== "" || attempt >= CassetteLLMClient.RECORD_RETRIES) return text;
      // eslint-disable-next-line no-console
      console.log(`[cassette] ${label} returned empty (attempt ${attempt + 1}), re-asking the provider`);
    }
  }

  private save(key: string, entry: CassetteEntry): void {
    this.store[key] = entry;
    this.records += 1;
    this.persist();
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    const prompt = JSON.stringify({ system, messages });
    const key = this.key("stream", role, prompt);
    const cached = this.store[key];

    if (cached && this.mode !== "record") {
      this.replays += 1;
      const text = cached.value as string;
      emitChunks(text, onChunk);
      return text;
    }
    if (this.mode === "replay") this.miss("stream", role);

    const text = await this.track(
      this.recordWithRetries(
        `stream (role=${role ?? "default"})`,
        () => this.inner.streamResponse(system, messages, onChunk, role)
      )
    );
    this.save(key, { method: "stream", role, preview: preview(prompt), value: text });
    return text;
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole
  ): Promise<string> {
    const prompt = JSON.stringify({ system, userMessage });
    const key = this.key("complete", role, prompt);
    const cached = this.store[key];

    if (cached && this.mode !== "record") {
      this.replays += 1;
      return cached.value as string;
    }
    if (this.mode === "replay") this.miss("complete", role);

    const text = await this.track(
      this.recordWithRetries(
        `complete (role=${role ?? "default"})`,
        () => this.inner.completeResponse(system, userMessage, maxTokens, role)
      )
    );
    this.save(key, { method: "complete", role, preview: preview(prompt), value: text });
    return text;
  }

  async completeJson<T>(system: string, userMessage: string, role?: LLMRole): Promise<T> {
    const prompt = JSON.stringify({ system, userMessage });
    const key = this.key("json", role, prompt);
    const cached = this.store[key];

    if (cached && this.mode !== "record") {
      this.replays += 1;
      return cached.value as T;
    }
    if (this.mode === "replay") this.miss("json", role);

    const value = await this.track(
      this.recordWithRetries(
        `json (role=${role ?? "default"})`,
        async () => JSON.stringify(await this.inner.completeJson<T>(system, userMessage, role))
      )
    ).then((serialized) => JSON.parse(serialized) as T);
    this.save(key, { method: "json", role, preview: preview(prompt), value });
    return value;
  }
}

/** Replay streaming by re-emitting the recorded text in small chunks, so the
 * streaming code paths (socket chunk fan-out, SSE writes) are still exercised. */
function emitChunks(text: string, onChunk: (chunk: string) => void): void {
  const SIZE = 8;
  for (let i = 0; i < text.length; i += SIZE) {
    onChunk(text.slice(i, i + SIZE));
  }
}

function preview(prompt: string): string {
  return prompt.replace(/\s+/g, " ").slice(0, 160);
}
