// The server hands back a per-game secret once, at creation. It is the only
// proof of ownership later requests can send (`x-game-secret`), so it lives
// next to the game id in localStorage.
//
// localStorage can be missing or throw (private windows, blocked site data,
// full quota). Neither helper may take the game down with it: a failed save is
// silent, a failed read is null.

const keyFor = (gameId: string) => `ri_game_secret:${gameId}`;

export function saveGameSecret(gameId: string, secret: string): void {
  try {
    localStorage.setItem(keyFor(gameId), secret);
  } catch {
    /* non-fatal: storage unavailable, the game just can't prove ownership later */
  }
}

export function getGameSecret(gameId: string): string | null {
  try {
    return localStorage.getItem(keyFor(gameId));
  } catch {
    return null;
  }
}

// The server also says, at creation, whether wait-time research can run for
// this game (`research` in the create response). It is a hint that lets the
// client skip the requests entirely; the server enforces the same gates
// itself. Absent (a game made before the hint existed) reads as null, and the
// caller then tries once as it always did.
const researchKeyFor = (gameId: string) => `ri_game_research:${gameId}`;

export function saveResearchHint(gameId: string, research: boolean): void {
  try {
    localStorage.setItem(researchKeyFor(gameId), research ? "1" : "0");
  } catch {
    /* non-fatal: with no hint the client just asks and gets its answer from the server */
  }
}

export function getResearchHint(gameId: string): boolean | null {
  try {
    const v = localStorage.getItem(researchKeyFor(gameId));
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}
