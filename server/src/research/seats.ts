import type { GameRepository } from "../db/repository.js";
import { logger } from "../logger.js";

/**
 * True when the game is (or may be) a shared multiplayer game. Uses both the
 * in-memory session check and the saved seats, so a server restart or session
 * eviction does not make a seated game look solo (the same rule
 * loadParentContext uses). Fails closed: if the lookup throws, the game is
 * treated as seated and only its id is logged.
 */
export async function isSeatedGame(
  gameId: string,
  repo: GameRepository,
  hasSeat: (gameId: string) => boolean,
): Promise<boolean> {
  if (hasSeat(gameId)) return true;
  try {
    return (await repo.loadPlayers(gameId)).length > 0;
  } catch {
    logger.warn("seat_lookup_failed", { gameId });
    return true;
  }
}
