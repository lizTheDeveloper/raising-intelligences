declare global {
  interface Window {
    umami?: { track: (event: string, data?: Record<string, string | number | boolean>) => void };
  }
}

export type EventProps = Record<string, string | number | boolean>;

/**
 * The single tracking chokepoint for this game. Everything goes through
 * `track()` — there is deliberately no second path — so the firehose rule
 * (docs/analytics/README.md §7) and the "did the script even load yet" problem
 * are solved once, here, instead of at every call site.
 */

/* ------------------------------------------------------------------ *
 * 1. The load race
 *
 * The Umami script is appended to <head> at runtime by main.tsx, from a module
 * script — so it is a *dynamically inserted* script and therefore async. It
 * lands well AFTER React's first render. Any event fired from a mount effect
 * (title_screen_viewed, support_prompt_shown, return_visit) would hit an
 * undefined `window.umami` and vanish silently — which would have made the
 * front-door instrumentation this file exists to add report zero.
 *
 * So: queue until the global appears, then flush in order. Bounded queue,
 * bounded wait, then give up — an analytics buffer must never grow without
 * limit or keep a timer alive forever on a page that simply has no analytics
 * (local dev, or a blocked host).
 * ------------------------------------------------------------------ */
const MAX_QUEUE = 50;
const POLL_MS = 400;
const MAX_POLLS = 50; // ~20s

const pending: Array<[string, EventProps | undefined]> = [];
let poller: ReturnType<typeof setInterval> | null = null;

function flushPending() {
  const umami = window.umami;
  if (!umami) return;
  for (const [event, data] of pending.splice(0, pending.length)) {
    umami.track(event, data);
  }
}

function startPolling() {
  if (poller !== null) return;
  let tries = 0;
  poller = setInterval(() => {
    tries += 1;
    if (window.umami) {
      flushPending();
      clearInterval(poller!);
      poller = null;
    } else if (tries >= MAX_POLLS) {
      clearInterval(poller!);
      poller = null;
      pending.length = 0;
    }
  }, POLL_MS);
}

/* ------------------------------------------------------------------ *
 * 2. Firehose containment
 *
 * Deterministic once-per-session-per-key dedup, never random sampling — the
 * same shape as Precursors' FIREHOSE_ONCE_PER_SESSION.
 *
 * `portrait_loaded` was the highest-volume event in the title: 2151 events
 * across 227 sessions (9.5/session), which made it the LAST custom event in
 * 139 of 335 sessions and destroyed exit-point analysis. Keyed on `ageBucket`
 * it keeps every bit of information it actually carried (at most 5 buckets
 * exist) at ~5% of the volume.
 * ------------------------------------------------------------------ */
const ONCE_PER_SESSION: Record<string, string[]> = {
  portrait_loaded: ["ageBucket"],
  portrait_failed: ["ageBucket"],
  support_prompt_shown: ["sourcePage"],
  support_clicked: ["sourcePage"],
  return_visit: [],
};

const alreadySent = new Set<string>();

export function track(event: string, data?: EventProps) {
  const keys = ONCE_PER_SESSION[event];
  if (keys) {
    const key = [event, ...keys.map((k) => String(data?.[k] ?? ""))].join("|");
    if (alreadySent.has(key)) return;
    alreadySent.add(key);
  }

  if (window.umami) {
    window.umami.track(event, data);
    return;
  }
  if (pending.length >= MAX_QUEUE) pending.shift();
  pending.push([event, data]);
  startPolling();
}

/* ------------------------------------------------------------------ *
 * 3. Timing marks
 *
 * The waits this game loses players in (the ~68s post-conversation LLM
 * generation, the 4-minute guardian form) start and end in different files —
 * useGame.ts sets `processing`, SoloGame.tsx renders the debrief. A shared
 * mark keeps that measurable without a second tracking path or prop-drilling
 * a timestamp through the component tree.
 * ------------------------------------------------------------------ */
const marks = new Map<string, number>();

export function mark(key: string) {
  marks.set(key, Date.now());
}

/** Seconds since `mark(key)`, or null if it was never marked this session. */
export function secondsSince(key: string): number | null {
  const t = marks.get(key);
  return t === undefined ? null : (Date.now() - t) / 1000;
}

/* ------------------------------------------------------------------ *
 * 4. Cardinality control
 *
 * Raw durations as numbers would put thousands of distinct values into
 * event_data. Bucket at the source; the buckets are a small fixed enum.
 * ------------------------------------------------------------------ */
export function bucketSeconds(seconds: number): string {
  if (seconds < 5) return "0-5s";
  if (seconds < 15) return "5-15s";
  if (seconds < 30) return "15-30s";
  if (seconds < 60) return "30-60s";
  if (seconds < 120) return "1-2m";
  if (seconds < 300) return "2-5m";
  if (seconds < 900) return "5-15m";
  return "15m+";
}

export function bucketHours(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 6) return "1-6h";
  if (hours < 24) return "6-24h";
  if (hours < 24 * 7) return "1-7d";
  return "7d+";
}

/* ------------------------------------------------------------------ *
 * 5. Session-level canonical events
 *
 * `session_milestone` and `return_visit` are the two canonical time/retention
 * events in docs/analytics/event-taxonomy.md and this title emitted neither —
 * so its 12.5% multi-day retention was derived from raw timestamps rather than
 * measured. Both are hard-bounded: at most one `return_visit`, and at most
 * seven `session_milestone`s, per session. Never per-tick.
 * ------------------------------------------------------------------ */
const MILESTONE_SECONDS = [30, 60, 300, 600, 900, 1800, 3600];
const LAST_VISIT_KEY = "ri_last_visit";
/** Below this, a reload is the same visit, not a return. */
const RETURN_GAP_MS = 30 * 60 * 1000;

let sessionTrackingStarted = false;

export function startSessionTracking() {
  if (sessionTrackingStarted) return;
  sessionTrackingStarted = true;

  try {
    const prev = Number(localStorage.getItem(LAST_VISIT_KEY) || 0);
    const now = Date.now();
    if (prev > 0 && now - prev > RETURN_GAP_MS) {
      track("return_visit", { sinceLast: bucketHours((now - prev) / 3_600_000) });
    }
    localStorage.setItem(LAST_VISIT_KEY, String(now));
  } catch {
    /* private mode / storage disabled — retention is not worth an exception */
  }

  for (const seconds of MILESTONE_SECONDS) {
    setTimeout(() => track("session_milestone", { seconds }), seconds * 1000);
  }
}
