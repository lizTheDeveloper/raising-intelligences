/**
 * Guards for the manual window error/rejection reporters in main.tsx.
 *
 * GlitchTip issue RAISING-INTELLIGENCES-G (GitHub #149): the listeners used to
 * call `Sentry.captureException(e.error)` / `captureException(e.reason)`
 * unconditionally. When the browser reports an event with NO error object —
 * a resource blocked by tracking protection, an opaque cross-origin script
 * error, or a `Promise.reject(null)` — the SDK serialized the null literally
 * and GlitchTip received an `error: null` event with nothing to fingerprint.
 *
 * These functions turn every capturable failure into a real Error carrying the
 * context the browser does expose, and return null for the two classes that
 * carry zero information about our code (blocked third-party resource loads
 * and cross-origin "Script error."), which we drop at the source instead of
 * shipping noise. Pure functions, so scripts/test-error-reporting.ts can
 * assert the behavior without a browser or the SDK.
 */

export interface WindowErrorInfo {
  /** The ErrorEvent's `error` property (null for resource/cross-origin errors). */
  error?: unknown;
  /** The ErrorEvent's `message` string ("" for resource errors). */
  message?: string;
  /** Script URL from the ErrorEvent ("" when the browser hides it). */
  filename?: string;
  lineno?: number;
  colno?: number;
  /** True when the event targeted a <script>/<img>/<link> — a resource load failure. */
  isResourceLoad?: boolean;
}

const MAX_MESSAGE_CHARS = 200;

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_MESSAGE_CHARS ? `${trimmed.slice(0, MAX_MESSAGE_CHARS)}…` : trimmed;
}

/** Minimal structural view of the Sentry event fields we touch. */
export interface ThrowableEvent {
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: { type?: string; handled?: boolean };
      stacktrace?: { frames?: Array<{ filename?: string; lineno?: number; colno?: number }> };
    }>;
  };
}

/**
 * Last-line guard: no exception may ever LEAVE the client with a null/empty
 * payload. The SDK's own BrowserApiErrors integration (setTimeout/RAF callbacks)
 * forwards `throw null` verbatim, which is the other half of the #149 noise.
 * Rewrites such events into something that fingerprints usefully.
 */
export function normalizeNullPayload<T extends ThrowableEvent>(event: T): T {
  for (const value of event.exception?.values ?? []) {
    if (value.value === "null" || value.value === "undefined" || value.value === "" || value.value == null) {
      const mech = value.mechanism?.type ?? "manual capture";
      const frames = value.stacktrace?.frames;
      const top = frames?.length ? frames[frames.length - 1] : undefined;
      const where = top?.filename ? ` (${top.filename}:${top.lineno ?? 0}:${top.colno ?? 0})` : "";
      value.type = "NullErrorPayload";
      value.value = `null error payload from ${mech}${where}`;
    }
  }
  return event;
}

/**
 * Map a window "error" event to something worth reporting, or null to drop.
 */
export function toReportableWindowError(info: WindowErrorInfo): Error | null {
  if (info.error instanceof Error) {
    return info.error;
  }
  // Resource load failures (<script src> blocked by tracking protection etc.):
  // the event carries nothing about our code, and these were the bulk of the
  // old `error: null` volume. Drop instead of reporting as null.
  if (info.isResourceLoad) {
    return null;
  }
  const message = (info.message ?? "").trim();
  // Opaque cross-origin error: the browser replaces the real message with the
  // constant "Script error." and hides the source URL. Unactionable by design.
  if (/^script error\.?$/i.test(message) && !info.filename) {
    return null;
  }
  const where = info.filename ? ` (${info.filename}:${info.lineno ?? 0}:${info.colno ?? 0})` : "";
  return new Error(`window error: ${message || "uncaught error with no message"}${where}`);
}

/**
 * Map an unhandledrejection reason to a real Error, never to null/undefined.
 * Non-Error object values are described by type and key names only — their
 * values are not serialized, so crash reports cannot carry transcript content.
 */
export function toReportableRejection(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (reason === null) {
    return new Error("unhandledrejection: promise rejected with null (a `Promise.reject(null)` or `throw null` site)");
  }
  if (reason === undefined) {
    return new Error("unhandledrejection: promise rejected with undefined (a bare `reject()`)");
  }
  if (typeof reason === "string") {
    return new Error(`unhandledrejection: ${truncate(reason) || "empty string reason"}`);
  }
  if (typeof reason === "object") {
    const obj = reason as Record<string, unknown>;
    const typeName = obj.constructor?.name ?? "Object";
    const keys = Object.keys(obj).slice(0, 10).join(",");
    return new Error(`unhandledrejection: non-Error ${typeName} {${keys}}`);
  }
  return new Error(`unhandledrejection: non-Error ${typeof reason}: ${truncate(String(reason))}`);
}
