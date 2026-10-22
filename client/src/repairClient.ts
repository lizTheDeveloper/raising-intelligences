/**
 * The optional "go back to that moment" message. A plain helper so the
 * behaviour the game depends on is testable without React: it never throws,
 * and any failure is just `false`, which the screen answers by letting the
 * player carry on without it.
 */

export const REPAIR_MAX_LENGTH = 1000;

export interface RepairDeps {
  gameId: string;
  /** The game's secret, if this device has one. Sent so the server may keep the words as research data. */
  secret: string | null;
  message: string;
  /** BASE_URL-style prefix ending in "/". */
  base: string;
  fetchFn: typeof fetch;
}

/**
 * "sent": accepted. "failed": did not go through, carry on without it.
 * "ended": the server refused it on safety grounds and ended the session (403),
 * which the screen must treat like a moderation block in chat, not as a failure.
 */
export type RepairResult = "sent" | "failed" | "ended";

export async function sendRepair(deps: RepairDeps): Promise<RepairResult> {
  try {
    const message = deps.message.trim();
    if (!message || Array.from(message).length > REPAIR_MAX_LENGTH) return "failed";
    const res = await deps.fetchFn(`${deps.base}api/game/${encodeURIComponent(deps.gameId)}/repair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(deps.secret ? { "x-game-secret": deps.secret } : {}),
      },
      body: JSON.stringify({ message }),
    });
    if (res.status === 204) return "sent";
    return res.status === 403 ? "ended" : "failed";
  } catch {
    return "failed";
  }
}
