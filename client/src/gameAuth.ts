import { getGameSecret } from "./hooks/gameSecret";
import { loadResume, type ResumeData, type SavedKid } from "./localStore";

/**
 * The credential each read of a game sends (privacy review F1). The server no
 * longer answers a game id alone: a solo game reads with its secret, a seat
 * with its own token, and a signed-in player on another device with a Matrix
 * OpenID token (which opens only games this account synced with proof).
 */

type MatrixLike = Pick<MatrixAuth, "isLoggedIn" | "getUserId" | "getOpenIdToken">;

let cachedToken: { token: string; until: number } | null = null;

/** Test seam. */
export function resetMatrixTokenCache(): void {
  cachedToken = null;
}

function currentMatrix(): MatrixLike | undefined {
  return typeof window === "undefined" ? undefined : window.matrixAuth;
}

/** `{ "x-matrix-openid": token }` for a signed-in player, else `{}`. Never throws. */
export async function matrixAuthHeaders(matrix: MatrixLike | undefined = currentMatrix(), now: () => number = Date.now): Promise<Record<string, string>> {
  try {
    if (!matrix?.isLoggedIn()) return {};
    if (cachedToken && cachedToken.until > now()) return { "x-matrix-openid": cachedToken.token };
    // Bounded: a homeserver that doesn't answer must not hold up a resume.
    const t = await Promise.race([
      matrix.getOpenIdToken(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!t?.access_token) return {};
    // Reuse until a minute before it expires (Synapse issues them for an hour).
    cachedToken = { token: t.access_token, until: now() + Math.max(0, (t.expires_in ?? 0) - 60) * 1000 };
    return { "x-matrix-openid": t.access_token };
  } catch {
    return {};
  }
}

export interface GameReadDeps {
  getSecret: (gameId: string) => string | null;
  loadResume: () => ResumeData | null;
  matrix: MatrixLike | undefined;
}

const defaultDeps = (): GameReadDeps => ({ getSecret: getGameSecret, loadResume, matrix: currentMatrix() });

/** The headers that read this game: its secret, else this player's seat token for it, else a Matrix sign-in. */
export async function gameReadHeaders(gameId: string, deps: GameReadDeps = defaultDeps()): Promise<Record<string, string>> {
  const secret = deps.getSecret(gameId);
  if (secret) return { "x-game-secret": secret };
  const resume = deps.loadResume();
  if (resume?.gameId === gameId && resume.playerToken) return { "x-player-token": resume.playerToken };
  return matrixAuthHeaders(deps.matrix);
}

/** Kids to sync, each with whatever proof of access this device holds for it. */
export function kidsWithProof(
  kids: SavedKid[],
  getSecret: (gameId: string) => string | null = getGameSecret,
  resume: ResumeData | null = loadResume(),
): Array<{ gameId: string; childName: string; secret?: string; playerToken?: string }> {
  return kids.map((k) => {
    const secret = getSecret(k.gameId);
    if (secret) return { gameId: k.gameId, childName: k.childName, secret };
    if (resume?.gameId === k.gameId && resume.playerToken) return { gameId: k.gameId, childName: k.childName, playerToken: resume.playerToken };
    return { gameId: k.gameId, childName: k.childName };
  });
}
