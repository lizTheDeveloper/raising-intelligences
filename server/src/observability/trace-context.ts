/**
 * Which game a model call belongs to, carried by the async context instead of
 * by every call site.
 *
 * The app has one traced model client (index.ts) shared by every game. A call
 * site can't be trusted to remember to scope it: before 2.12.2 none did, so no
 * Langfuse trace carried a game id, and the per-game tags that depend on it
 * (`hosted_no_analysis`, H18, and `child_safety_hold`) were never on any trace.
 *
 * So the game is set once, where a request or socket event enters the server
 * (the socket middleware in socket/handlers.ts, the `/api/game/:id` middleware
 * in app.ts, game creation in routes/game.ts), and everything that runs from
 * there, awaits, timers and fire-and-forget work included, sees it.
 * TracedLLMClient reads it on every call and refuses to send a trace without
 * one (see `TracedLLMClient.scope`).
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface GameTraceContext {
  gameId: string;
}

const store = new AsyncLocalStorage<GameTraceContext>();

/**
 * Runs `fn` as work for `gameId`. With no game (a socket that hasn't joined
 * one, game creation before the id exists), `fn` runs outside any game, even
 * when called from inside one, so it can't inherit the wrong game.
 */
export function runInGameContext<T>(gameId: string | null | undefined, fn: () => T): T {
  return gameId ? store.run({ gameId }, fn) : store.exit(fn);
}

/** The game the current async context is working for, if any. */
export function currentGameId(): string | undefined {
  return store.getStore()?.gameId;
}
