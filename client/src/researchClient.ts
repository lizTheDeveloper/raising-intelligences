import type { Question, WaitKind } from "./researchTypes";

/**
 * The non-React half of the wait-time questions. One session is one `active`
 * cycle of one wait: it fetches the questions once, serves them a card at a
 * time, and posts each answer fire-and-forget.
 *
 * Everything here is written so that research can never cost the player
 * anything: no method throws, no promise it starts can reject unhandled, and
 * once `dispose()` runs nothing it started can show a card or post again. The
 * hook creates a fresh session per cycle and disposes the old one, which is
 * what keeps a slow response from one wait out of the next.
 */

/**
 * How long a wait must have lasted before a card is shown. A near-instant wait
 * (a prefetched scene) would otherwise flash a card for a moment and count as
 * "shown" without the player ever having a chance to read it.
 */
export const SHOW_AFTER_MS = 1500;

export interface WaitSessionDeps {
  gameId: string;
  secret: string;
  wait: WaitKind;
  /**
   * Captured when the session starts, and posted with every answer. It is the
   * scene the card was shown in; by the time the player answers the game may
   * have moved on, and the answer still belongs to the scene they saw.
   */
  sceneIndex: number;
  /** BASE_URL-style prefix ending in "/". */
  base: string;
  fetchFn: typeof fetch;
  now: () => number;
  /** The server's hint for this game: false means make no requests at all. null/undefined = unknown, ask once. */
  research?: boolean | null;
  /** Overridable for tests; defaults to SHOW_AFTER_MS. */
  showAfterMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Receives the card to show, or null for none. Never called after dispose(). */
  onCurrent: (q: Question | null) => void;
  /** Analytics. Props are ids only, never answer text. */
  onEvent: (event: "wait_question_shown" | "wait_question_answered" | "wait_question_skipped", props: { questionId: string; wait: WaitKind }) => void;
}

export interface WaitSession {
  start: () => void;
  submit: (answer: unknown) => void;
  skip: () => void;
  dispose: () => void;
}

function isQuestion(q: unknown): q is Question {
  if (typeof q !== "object" || q === null) return false;
  const r = q as Record<string, unknown>;
  const a = r.answer as Record<string, unknown> | null | undefined;
  return (
    typeof r.id === "string" &&
    typeof r.version === "number" &&
    typeof r.prompt === "string" &&
    typeof a === "object" &&
    a !== null &&
    ((a.type === "tap" && Array.isArray(a.options)) || (a.type === "text" && typeof a.maxLength === "number"))
  );
}

export function createWaitSession(deps: WaitSessionDeps): WaitSession {
  const { gameId, secret, wait, sceneIndex, base, fetchFn, now, onCurrent, onEvent } = deps;
  const showAfterMs = deps.showAfterMs ?? SHOW_AFTER_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let showTimer: unknown = null;
  let startedAt = 0;
  const controller = new AbortController();
  let disposed = false;
  let started = false;
  let queue: Question[] = [];
  let current: Question | null = null;
  let shownAt = 0;

  const headers = { "x-game-secret": secret };

  function emit(q: Question | null) {
    if (disposed) return;
    try {
      onCurrent(q);
    } catch {
      /* a render-side failure must not reach the game */
    }
  }

  function trackSafe(event: Parameters<WaitSessionDeps["onEvent"]>[0], questionId: string) {
    try {
      onEvent(event, { questionId, wait });
    } catch {
      /* analytics is best-effort */
    }
  }

  function showNext() {
    const next = queue.shift() ?? null;
    current = next;
    if (next) {
      shownAt = now();
      emit(next);
      trackSafe("wait_question_shown", next.id);
    } else {
      emit(null);
    }
  }

  function post(q: Question, body: { answer?: unknown; skipped?: boolean }) {
    // Fire-and-forget. The catch is the only handler, so a rejected fetch (or a
    // fetchFn that throws synchronously) never becomes an unhandled rejection.
    try {
      void fetchFn(`${base}api/game/${encodeURIComponent(gameId)}/answers`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: q.id, version: q.version, sceneIndex, shownAt, ...body }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* swallowed on purpose */
    }
  }

  function resolve(body: { answer?: unknown; skipped?: boolean }) {
    // `current` is cleared before anything else, so a second click on the same
    // card finds nothing to resolve.
    if (disposed || !current) return;
    const q = current;
    current = null;
    post(q, body);
    trackSafe(body.skipped ? "wait_question_skipped" : "wait_question_answered", q.id);
    showNext();
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      if (deps.research === false) return;
      startedAt = now();
      const qs = new URLSearchParams({ wait, sceneIndex: String(sceneIndex) });
      let request: Promise<Response>;
      try {
        request = fetchFn(`${base}api/game/${encodeURIComponent(gameId)}/questions?${qs}`, {
          headers,
          signal: controller.signal,
        });
      } catch {
        return;
      }
      request
        .then(async (res) => {
          if (res.status !== 200) return;
          const data = (await res.json()) as { questions?: unknown };
          // Re-checked after the await: the wait may have ended while the body streamed.
          if (disposed || !Array.isArray(data.questions)) return;
          queue = data.questions.filter(isQuestion).slice(0, 2);
          // Hold the card until the wait has lasted long enough to be worth it.
          const remaining = showAfterMs - (now() - startedAt);
          if (remaining > 0) {
            showTimer = setTimer(() => {
              showTimer = null;
              if (!disposed) showNext();
            }, remaining);
          } else {
            showNext();
          }
        })
        .catch(() => {});
    },
    submit(answer) {
      resolve({ answer });
    },
    skip() {
      resolve({ skipped: true });
    },
    dispose() {
      disposed = true;
      if (showTimer !== null) clearTimer(showTimer);
      showTimer = null;
      current = null;
      queue = [];
      controller.abort();
    },
  };
}
