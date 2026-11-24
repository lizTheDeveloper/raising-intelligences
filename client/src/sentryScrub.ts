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

type ScrubbableBreadcrumb = { data?: Record<string, unknown>; message?: string };

const MEETUP_PARAM = /([?&#](?:meetup|hostinvite)=)[^&#\s"'<>]*/gi;

/**
 * A meetup code names the event a player tried to attend (privacy review F5).
 * URLs already lose their query; this cuts the code out of any other text an
 * event carries (a message or exception that quotes a URL).
 */
export function scrubMeetup(text: string): string {
  return text.replace(MEETUP_PARAM, "$1[scrubbed]");
}

/**
 * Breadcrumbs ride along on every later event. Navigation crumbs carry
 * `data.from` / `data.to` (the pre-replaceState URL, `#handoff=` code and all),
 * browser fetch/xhr crumbs carry the full `data.url`, and Node outgoing-http
 * crumbs keep the query and fragment apart in `http.query` / `http.fragment`.
 * Used as `beforeBreadcrumb`, so nothing is stored unscrubbed. Mutates and
 * returns the breadcrumb.
 */
export function scrubBreadcrumb<B extends ScrubbableBreadcrumb>(crumb: B): B {
  const data = crumb.data;
  if (data) {
    for (const key of ["url", "from", "to"]) {
      if (typeof data[key] === "string") data[key] = stripQuery(data[key] as string);
    }
    delete data["http.query"];
    delete data["http.fragment"];
  }
  if (typeof crumb.message === "string") crumb.message = scrubMeetup(crumb.message);
  return crumb;
}

type ScrubbableText = {
  message?: unknown;
  transaction?: unknown;
  exception?: { values?: Array<{ value?: unknown }> };
};

/** stripRequestBody plus scrubBreadcrumb over any breadcrumbs already on the event, and no meetup code in its text. */
export function scrubEvent<T extends { request?: ScrubbableRequest; breadcrumbs?: ScrubbableBreadcrumb[] } & ScrubbableText>(event: T): T {
  stripRequestBody(event);
  for (const b of event.breadcrumbs ?? []) scrubBreadcrumb(b);
  if (typeof event.message === "string") event.message = scrubMeetup(event.message);
  if (typeof event.transaction === "string") event.transaction = scrubMeetup(event.transaction);
  for (const v of event.exception?.values ?? []) if (typeof v.value === "string") v.value = scrubMeetup(v.value);
  return event;
}
