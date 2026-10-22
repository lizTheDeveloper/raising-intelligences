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
