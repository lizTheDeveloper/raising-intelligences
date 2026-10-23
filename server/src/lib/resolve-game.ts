import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { logger } from "../logger.js";
import { loadParentContext } from "../research/parent-context.js";

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
  // A failed research lookup must never break gameplay: log the id only and
  // carry on without a context.
  const parentContext = await loadParentContext(id, repo).catch(() => {
    logger.warn("parent_context_load_failed", { gameId: id });
    return undefined;
  });
  const state = parentContext ? { ...loaded, parentContext } : loaded;
  // Another request may have rehydrated while this one awaited; keep that copy.
  const raced = games.get(id);
  if (raced) return raced;
  games.set(id, state);
  return state;
}
