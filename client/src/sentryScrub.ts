/**
 * Browser error events must not carry the page's query string or fragment.
 * @sentry/browser sets `request.url` to `location.href` and copies `Referer`,
 * so a crash on a link carrying `?handoff=` / `#handoff=` (a device-handoff
 * code) would store that code in GlitchTip. The same holds for a future
 * `?token=`.
 *
 * Mirrors server/src/observability/sentry-scrub.ts (the packages share no
 * source): header allowlist, and body, cookies and query string dropped.
 */
const SAFE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-length",
  "content-type",
  "host",
  "origin",
  "referer",
  "user-agent",
  "x-forwarded-proto",
]);

type ScrubbableRequest = {
  data?: unknown;
  cookies?: unknown;
  headers?: Record<string, string>;
  query_string?: unknown;
  url?: string;
};

/** Cuts the query and the fragment (a `#handoff=` code lives there). */
export function stripQuery(url: string): string {
  const q = url.search(/[?#]/);
  return q === -1 ? url : url.slice(0, q);
}

export function stripRequestBody<T extends { request?: ScrubbableRequest }>(event: T): T {
  const req = event.request;
  if (req) {
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    if (req.headers) {
      req.headers = Object.fromEntries(
        Object.entries(req.headers)
          .filter(([name]) => SAFE_HEADERS.has(name.toLowerCase()))
          .map(([name, value]) => [
            name,
            name.toLowerCase() === "referer" && typeof value === "string" ? stripQuery(value) : value,
          ]),
      );
    }
    if (typeof req.url === "string") req.url = stripQuery(req.url);
  }
  return event;
}
