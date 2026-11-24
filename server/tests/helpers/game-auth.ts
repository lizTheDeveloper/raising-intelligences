import type { GameRepository } from "../../src/db/repository.js";
import { GAME_SECRET_HEADER, newGameSecret } from "../../src/security/game-secret.js";

/**
 * Give a game a test built directly (createGame + games.set/saveGame) the
 * per-game secret a REST-created game gets, and return the header that
 * authorizes its reads and writes.
 */
export async function secretHeaders(repo: GameRepository, gameId: string): Promise<Record<string, string>> {
  const { secret, hash } = newGameSecret();
  await repo.recordAccessSecretHash(gameId, hash);
  return { [GAME_SECRET_HEADER]: secret };
}
