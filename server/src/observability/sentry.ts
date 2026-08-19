/**
 * Sentry / GlitchTip error reporting layer.
 *
 * Reports server-side errors to a self-hosted, Sentry-protocol-compatible
 * GlitchTip instance. Mirrors the design of the Langfuse layer: reporting is
 * *fully optional*. If `SENTRY_DSN` is not set, `initSentry()` never calls
 * `Sentry.init`, `isSentryEnabled()` is false, and every helper here becomes a
 * transparent no-op — no network calls, no behavior change. This keeps local
 * development, tests, and CI completely unaffected.
 *
 * What it captures once a DSN is configured:
 *   - Express errors, via the exported `sentryExpressErrorHandler` middleware
 *     registered just before the app's own error handler (see app.ts).
 *   - socket.io handler errors, via `captureException` at the catch sites in
 *     socket/handlers.ts (those handlers swallow errors into a client-facing
 *     `fail(...)`, so the global handlers below never see them).
 *   - `uncaughtException` / `unhandledRejection`, handled automatically by
 *     @sentry/node's default integrations once `Sentry.init` runs — we do not
 *     hand-roll `process.on` handlers, which would double-report and fight the
 *     SDK's exit behavior.
 */
import * as Sentry from "@sentry/node";
import type { ErrorRequestHandler } from "express";

let enabled = false;
let initialized = false;

/**
 * True for benign client-disconnect noise, NOT a server bug: a browser aborting
 * an in-flight SSE stream or fetch (navigation, tab close, a superseded request)
 * surfaces server-side as an AbortError, or a mid-write ECONNRESET/EPIPE. There
 * is nothing the server can do about it, and left unfiltered it buries real
 * errors in GlitchTip (mirrors the client's beforeSend in client/src/main.tsx).
 */
export function isBenignDisconnect(params: {
  name?: string;
  message?: string;
  code?: string;
}): boolean {
  const { name = "", message = "", code = "" } = params;
  if (name === "AbortError") return true;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return true;
  return /operation was aborted|request aborted|\baborted\b/i.test(message);
}

/**
 * Initializes Sentry when `SENTRY_DSN` is set. Idempotent: safe to call more
 * than once (subsequent calls are no-ops). Returns whether reporting is active.
 *
 * Required env: SENTRY_DSN (the GlitchTip ingest DSN).
 * Optional env: SENTRY_ENVIRONMENT, SENTRY_RELEASE.
 */
export function initSentry(): boolean {
  if (initialized) return enabled;
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    enabled = false;
    return enabled;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE,
    // Error reporting only — no performance/trace sampling. GlitchTip is an
    // error tracker; tracing spans are unnecessary overhead here.
    tracesSampleRate: 0,
    // Drop benign client-disconnect noise (aborted SSE/fetch) so it doesn't
    // bury real server errors. See isBenignDisconnect.
    beforeSend(event, hint) {
      const err = hint?.originalException as
        | { name?: string; message?: string; code?: string }
        | undefined;
      const name = event.exception?.values?.[0]?.type ?? err?.name;
      const message = event.exception?.values?.[0]?.value ?? err?.message;
      const code = err?.code;
      return isBenignDisconnect({ name, message, code }) ? null : event;
    },
  });
  enabled = true;
  return enabled;
}

/** True when Sentry is configured and error reporting is active. */
export function isSentryEnabled(): boolean {
  return enabled;
}

/**
 * Reports an exception to Sentry. A silent no-op when reporting is disabled, so
 * callers can wrap it unconditionally. Optional `context` is attached as tags
 * (e.g. `{ component: "socket", event: "PARENT_MESSAGE" }`).
 */
export function captureException(
  error: unknown,
  context?: { tags?: Record<string, string> }
): void {
  if (!enabled) return;
  Sentry.captureException(error, context?.tags ? { tags: context.tags } : undefined);
}

/**
 * Express error-handling middleware that reports the error to Sentry, then
 * delegates to the next error handler (which sends the client response). A
 * pass-through no-op when reporting is disabled. Must be registered *before*
 * the app's own error handler so the response is still produced there.
 */
export const sentryExpressErrorHandler: ErrorRequestHandler = (err, _req, _res, next) => {
  captureException(err, { tags: { component: "express" } });
  next(err);
};

/**
 * Flushes any buffered events to Sentry. No-op when unconfigured. Call on
 * graceful shutdown so in-flight error reports are not lost.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs);
}

/**
 * Resets module state. Intended for tests so env changes take effect.
 * @internal
 */
export function __resetSentryForTests(): void {
  enabled = false;
  initialized = false;
}
