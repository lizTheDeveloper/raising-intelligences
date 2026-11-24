/**
 * The Umami script tag's attributes.
 *
 * Load analytics from the host matching the domain the user actually reached.
 * Some ISPs (e.g. Comcast) SNI-block the .xyz TLD, which is why we also serve
 * on .ai — a user on multiversegames.ai cannot reach analytics.multiversestudios.xyz,
 * so hardcoding either host silently drops half the traffic. Pick by domain;
 * default to .ai (the non-blocked host) for anything else. Both hosts serve the
 * same Umami instance and are allowlisted in the server CSP (see app.ts).
 *
 * `data-exclude-search` (privacy review F5): Umami records page URLs, and
 * these carry `?game=<id>` and `?meetup=<code>` (the event a player opened).
 * No event here reads the query string: every custom event sends its own
 * properties (mode, source, …). The cost is that ad click ids (fbclid, utm_*)
 * are no longer recorded either.
 */
export function umamiScriptAttributes(hostname: string): Record<string, string> {
  const host = hostname.endsWith("multiversestudios.xyz")
    ? "https://analytics.multiversestudios.xyz"
    : "https://analytics.multiversegames.ai";
  return {
    src: `${host}/script.js`,
    "data-website-id": "70687d81-c604-4643-a6b6-9d0bccdba970",
    "data-exclude-search": "true",
    "data-before-send": BEFORE_SEND_HOOK,
  };
}

/** The global the Umami tracker calls with every payload before sending it. */
export const BEFORE_SEND_HOOK = "__riUmamiBeforeSend";

/**
 * Global Privacy Control (spec's prototype checklist; persona tests, finding
 * 8): a browser that sends it gets no Umami at all, no script and no events.
 */
export function analyticsAllowed(nav: { globalPrivacyControl?: unknown } | undefined): boolean {
  return nav?.globalPrivacyControl !== true;
}

/** Cuts the query and the fragment. */
function noQuery(url: unknown): string {
  if (typeof url !== "string") return "";
  const q = url.search(/[?#]/);
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Every Umami payload, before it leaves. A session that began at a meetup
 * card, the host portal, the deck or the account page sends no referrer at
 * all: the page before it is a promoter's or a host's, and "came from Spark
 * Night" is a tag on the player. No referrer or url ever carries a query or
 * a fragment (a meetup code, a game id, a handoff).
 */
export function umamiBeforeSend<P extends { url?: unknown; referrer?: unknown }>(
  _type: string,
  payload: P,
  ctx: { meetupSession: boolean },
): P {
  return {
    ...payload,
    ...(payload.url !== undefined ? { url: noQuery(payload.url) } : {}),
    referrer: ctx.meetupSession ? "" : noQuery(payload.referrer),
  };
}

export const MEETUP_SESSION_KEY = "ri_meetup_session";

/**
 * Whether this tab's session began at a meetup card, the portal, the deck or
 * the account page. Kept for the tab, so the title screen a player reloads to
 * after a card still sends no referrer. Storage that throws counts as no.
 */
export function meetupSession(landing: boolean, storage: Pick<Storage, "getItem" | "setItem"> | undefined): boolean {
  try {
    if (landing) storage?.setItem(MEETUP_SESSION_KEY, "1");
    return landing || storage?.getItem(MEETUP_SESSION_KEY) === "1";
  } catch {
    return landing;
  }
}
