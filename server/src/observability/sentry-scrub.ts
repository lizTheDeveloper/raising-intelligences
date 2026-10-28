/**
 * Error events must not carry request bodies, credentials, or query strings.
 *
 * This server reads credentials from request headers: admin and child-safety
 * routes take `Authorization: Bearer <admin token>`, and game routes take
 * `x-game-secret`. With `sendDefaultPii: false` and no scrub, @sentry/node
 * still copies every incoming header (Authorization and Cookie included) into
 * the event, so a 5xx on one of those routes would store the token in
 * GlitchTip verbatim.
 *
 * Headers are an allowlist, not a denylist: a header added later must not
 * start leaking by default. Same pattern as llm-token-proxy's
 * src/sentry-scrub.ts (2026-10-27). The client has its own copy in
 * client/src/sentryScrub.ts, because the two packages share no source.
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
