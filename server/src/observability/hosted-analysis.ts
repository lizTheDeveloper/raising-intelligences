/**
 * Games played at a host-tools meetup are never analysed by default (host
 * tools spec, H18). Every Langfuse trace for such a game carries
 * HOSTED_NO_ANALYSIS_TAG. Anything that reads Langfuse in bulk (the ri-devlog
 * skill, scripts/model-search.ts, any agent export) drops those traces unless
 * the game is on the analysis allow-list: a studio-event game where both
 * players said yes to studio learning, and that isn't excluded
 * (GET /api/admin/host-tools/analysis-allowlist).
 *
 * Without the allow-list (no admin URL or token), a reader drops every hosted
 * trace: it fails closed.
 *
 * Dependency-free on purpose so scripts can import it with tsx.
 */

export const HOSTED_NO_ANALYSIS_TAG = "hosted_no_analysis";

/**
 * Games known to be at an event, in this process. Filled when a game is
 * matched at an event, when a run's seats are read, and at boot from every
 * event's runs, before any play resumes. Never emptied: a game stays hosted.
 */
const hostedGamesInProcess = new Set<string>();

export function markGameHosted(gameId: string | null | undefined): void {
  if (gameId) hostedGamesInProcess.add(gameId);
}

export function isGameHosted(gameId: string | undefined): boolean {
  return !!gameId && hostedGamesInProcess.has(gameId);
}

/** @internal */
export function __resetHostedGamesForTests(): void {
  hostedGamesInProcess.clear();
}

interface TraceLike {
  id: string;
  tags?: string[] | null;
}

const gameOf = (t: TraceLike): string | null => {
  const tag = (t.tags ?? []).find((x) => x.startsWith("game_id:"));
  return tag ? tag.slice("game_id:".length) : null;
};

/**
 * The traces a bulk reader may use at all: only those that name their game.
 * Before RI 2.12.2 no trace carried `game_id:<id>`, so neither
 * `hosted_no_analysis` nor `child_safety_hold` could ever be applied to them
 * (games with child-safety cases from July and August 2026 are among them).
 * Since 2.12.2 every trace names its game, so a trace without one is either
 * older than that or a bug; either way a reader can't tell whether it is
 * hosted or held, and drops it (fail closed).
 */
export function gameTaggedTraceIds(traces: TraceLike[]): Set<string> {
  return new Set(traces.filter((t) => gameOf(t) !== null).map((t) => t.id));
}

/** The hosted traces a reader must drop: every one whose game isn't on the allow-list. */
export function hostedTraceIdsToDrop(traces: TraceLike[], allowed: Set<string>): Set<string> {
  const drop = new Set<string>();
  for (const t of traces) {
    if (!(t.tags ?? []).includes(HOSTED_NO_ANALYSIS_TAG)) continue;
    const game = gameOf(t);
    if (!game || !allowed.has(game)) drop.add(t.id);
  }
  return drop;
}

export function filterHostedObservations<O extends { traceId?: string | null }>(observations: O[], drop: Set<string>): O[] {
  return observations.filter((o) => !(o.traceId && drop.has(o.traceId)));
}

type LangfuseGet = (path: string, params?: Record<string, string>) => Promise<unknown>;

/** Every hosted trace (paginated over /api/public/traces?tags=hosted_no_analysis). */
export async function fetchHostedTraces(get: LangfuseGet, maxPages = 50): Promise<TraceLike[]> {
  const out: TraceLike[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = (await get("/api/public/traces", { tags: HOSTED_NO_ANALYSIS_TAG, limit: "100", page: String(page) })) as { data?: TraceLike[] };
    const data = res.data ?? [];
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

/**
 * The allow-list from the RI admin API. Any failure, or no URL or token,
 * gives an empty list: every hosted trace is then dropped.
 */
export async function fetchAnalysisAllowlist(baseUrl: string | undefined, adminToken: string | undefined): Promise<Set<string>> {
  if (!baseUrl || !adminToken) return new Set();
  try {
    const res = await fetch(new URL("api/admin/host-tools/analysis-allowlist", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`), {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!res.ok) return new Set();
    const body = (await res.json()) as { games?: unknown };
    return new Set(Array.isArray(body.games) ? body.games.filter((g): g is string => typeof g === "string") : []);
  } catch {
    return new Set();
  }
}
