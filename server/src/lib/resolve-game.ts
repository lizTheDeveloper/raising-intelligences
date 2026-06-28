import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";

export async function resolveGame(
  id: string,
  games: Map<string, GameState>,
  repo: GameRepository
): Promise<GameState | null> {
  const inMemory = games.get(id);
  if (inMemory) return inMemory;
  const loaded = await repo.loadGame(id);
  if (loaded) games.set(id, loaded);
  return loaded;
}
