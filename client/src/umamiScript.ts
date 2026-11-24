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
  };
}
