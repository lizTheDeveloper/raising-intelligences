/**
 * The non-React half of the optional follow-up offer. Plain functions so they
 * can be tested with a fake fetch. Nothing here throws, and nothing here logs,
 * stores or tracks the email: it goes in one request body and nowhere else.
 */

export type FollowupResult = "saved" | "failed" | "unavailable";

interface Common {
  gameId: string;
  /** The per-game secret; with none there is nothing to prove ownership with, so no request is made. */
  secret: string | null;
  /** BASE_URL-style prefix ending in "/". */
  base: string;
  fetchFn: typeof fetch;
}

/** Light client-side check only; the server is the authority. */
export function looksLikeEmail(raw: string): boolean {
  const s = raw.trim();
  if (s.length === 0 || s.length > 254 || /\s/.test(s)) return false;
  const parts = s.split("@");
  if (parts.length !== 2 || parts[0].length === 0) return false;
  const labels = parts[1].split(".");
  return labels.length >= 2 && labels.every((l) => l.length > 0);
}

function resultFor(status: number): FollowupResult {
  if (status === 204 || status === 200) return "saved";
  // The server answers 403/404 when follow-ups are not available for this game.
  if (status === 403 || status === 404) return "unavailable";
  return "failed";
}

async function send(c: Common, init: RequestInit): Promise<FollowupResult> {
  if (!c.secret) return "unavailable";
  try {
    const res = await c.fetchFn(`${c.base}api/research/followup/${encodeURIComponent(c.gameId)}`, init);
    return resultFor(res.status);
  } catch {
    return "failed";
  }
}

/** Sends the email with both consents. The caller must only call this once the player ticked both boxes. */
export function saveFollowup(c: Common & { email: string }): Promise<FollowupResult> {
  return send(c, {
    method: "POST",
    headers: { "x-game-secret": c.secret ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ email: c.email.trim(), consentFollowup: true, consentAiAnalysis: true }),
  });
}

/** Withdraws consent and deletes the stored email. */
export function withdrawFollowup(c: Common): Promise<FollowupResult> {
  return send(c, { method: "DELETE", headers: { "x-game-secret": c.secret ?? "" } });
}
