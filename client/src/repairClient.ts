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

export async function sendRepair(deps: RepairDeps): Promise<boolean> {
  try {
    const message = deps.message.trim();
    if (!message || Array.from(message).length > REPAIR_MAX_LENGTH) return false;
    const res = await deps.fetchFn(`${deps.base}api/game/${encodeURIComponent(deps.gameId)}/repair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(deps.secret ? { "x-game-secret": deps.secret } : {}),
      },
      body: JSON.stringify({ message }),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}
