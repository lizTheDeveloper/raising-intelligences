import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { withParentContext } from "../research/parent-context.js";

export async function resolveGame(
  id: string,
  games: Map<string, GameState>,
  repo: GameRepository
): Promise<GameState | null> {
  const inMemory = games.get(id);
  if (inMemory) return inMemory;
  const loaded = await repo.loadGame(id);
  if (!loaded) return null;
  // parentContext is in-memory only: rebuild it (research-enabled adult games
  // only) whenever a game is brought back from the repo.
  const state = await withParentContext(loaded, repo);
  // Another request may have rehydrated while this one awaited; keep that copy.
  const raced = games.get(id);
  if (raced) return raced;
  games.set(id, state);
  return state;
}
