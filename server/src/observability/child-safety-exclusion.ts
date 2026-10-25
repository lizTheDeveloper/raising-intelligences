/**
 * Keeping child-safety evidence from spreading through Langfuse.
 *
 * When a case opens, every Langfuse trace for that game gets the
 * CHILD_SAFETY_HOLD_TAG (holdGameTraces). Anything that reads Langfuse in
 * bulk — scripts/model-search.ts, the RI devlog skill, any agent export —
 * must drop held traces and their observations (fetchHeldTraceIds +
 * filterHeldObservations / filterHeldTraces).
 *
 * The moderation call itself no longer sends flagged content to Langfuse at
 * all (see openai-moderation.ts); the tag covers the other calls in the same
 * game (scene reader, psychologist, kid replies) whose inputs quote it.
 *
 * Dependency-free on purpose so scripts can import it with tsx.
 */

export const CHILD_SAFETY_HOLD_TAG = "child_safety_hold";

/**
 * Games with an open case in this process. TracedLLMClient adds the hold tag
 * to any further trace for them, so calls made after the flag (an ending
 * scene's psychologist pass, say) are held from the start.
 */
const heldGamesInProcess = new Set<string>();
export function markGameHeld(gameId: string): void {
  heldGamesInProcess.add(gameId);
}
export function isGameHeldInProcess(gameId: string | undefined): boolean {
  return !!gameId && heldGamesInProcess.has(gameId);
}

export interface TraceLike {
  id: string;
  tags?: string[] | null;
}

export interface ObservationLike {
  traceId?: string | null;
}

export function isHeldTrace(t: TraceLike): boolean {
  return Array.isArray(t.tags) && t.tags.includes(CHILD_SAFETY_HOLD_TAG);
}

/** Game ids (from `game_id:<id>` tags) of held traces, so a reader can drop untagged stragglers of the same game. */
export function heldGameIds(traces: TraceLike[]): Set<string> {
  const ids = new Set<string>();
  for (const t of traces) {
    if (!isHeldTrace(t)) continue;
    for (const tag of t.tags ?? []) if (tag.startsWith("game_id:")) ids.add(tag.slice("game_id:".length));
  }
  return ids;
}

export function filterHeldTraces<T extends TraceLike>(traces: T[], heldGames: Set<string> = heldGameIds(traces)): T[] {
  return traces.filter((t) => {
    if (isHeldTrace(t)) return false;
    return !(t.tags ?? []).some((tag) => tag.startsWith("game_id:") && heldGames.has(tag.slice("game_id:".length)));
  });
}

export function filterHeldObservations<O extends ObservationLike>(observations: O[], heldTraceIds: Set<string>): O[] {
  return observations.filter((o) => !(o.traceId && heldTraceIds.has(o.traceId)));
}

type LangfuseGet = (path: string, params?: Record<string, string>) => Promise<unknown>;

/** Every held trace id (paginated over /api/public/traces?tags=child_safety_hold). */
export async function fetchHeldTraceIds(get: LangfuseGet, maxPages = 50): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const res = (await get("/api/public/traces", {
      tags: CHILD_SAFETY_HOLD_TAG, limit: "100", page: String(page),
    })) as { data?: TraceLike[] };
    const data = res.data ?? [];
    for (const t of data) ids.add(t.id);
    if (data.length < 100) break;
  }
  return ids;
}

/**
 * Adds the hold tag to every existing trace of a game. Langfuse merges a
 * trace upsert by id, so re-sending the trace with the full tag list (old
 * tags + hold) tags it in place. Best effort: failures are reported to the
 * caller's catch, never thrown into gameplay.
 */
export async function holdGameTraces(gameId: string): Promise<number> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return 0;
  const host = process.env.LANGFUSE_BASEURL ?? process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const { getLangfuseClient } = await import("./langfuse.js");
  const client = getLangfuseClient();
  if (!client) return 0;
  // Make sure the game's in-flight traces have landed before listing them.
  await client.flushAsync().catch(() => {});

  let tagged = 0;
  for (let page = 1; page <= 20; page++) {
    const url = new URL("/api/public/traces", host);
    url.searchParams.set("tags", `game_id:${gameId}`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("page", String(page));
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`langfuse traces ${res.status}`);
    const body = (await res.json()) as { data?: Array<TraceLike> };
    const data = body.data ?? [];
    for (const t of data) {
      if (isHeldTrace(t)) continue;
      client.trace({ id: t.id, tags: [...(t.tags ?? []), CHILD_SAFETY_HOLD_TAG] });
      tagged++;
    }
    if (data.length < 100) break;
  }
  await client.flushAsync().catch(() => {});
  return tagged;
}
