import type { EndgameEngine, AlbumData } from "./endgame-engine.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { generateMomentIllustrations } from "../portrait-gen.js";
import { logger } from "../logger.js";

/**
 * Run moment illustrations for a set of album moments and fold the resulting
 * image paths back in, ready for `saveAlbumMoments`. Shared by the solo
 * (HTTP endgame) and multiplayer (socket endgame) album paths so both build
 * the persisted moment rows identically.
 */
export async function buildMomentsWithImages(
  gameId: string,
  albumData: AlbumData
): Promise<Array<{ age: number; title: string; description: string; momentType: string; imagePath: string | null; sortOrder: number }>> {
  const illustrations = await generateMomentIllustrations(
    gameId,
    albumData.moments.map((m, i) => ({ visualPrompt: m.visualPrompt, sortOrder: i }))
  );
  return albumData.moments.map((m, i) => ({
    age: m.age,
    title: m.title,
    description: m.description,
    momentType: m.momentType,
    imagePath: illustrations[i]?.imagePath ?? null,
    sortOrder: i,
  }));
}

export interface MultiplayerAlbumPlayer {
  userId?: string | null;
  displayName: string;
}

/**
 * Generate a completed multiplayer game's Family Album entries — mirroring the
 * solo flow, but for two real co-parents.
 *
 * The scrapbook moments are keyed by `game_id` and shared by both parents, so
 * they are generated ONCE for the game (generating them per player would insert
 * duplicate rows for the same child). Then, for EACH signed-in player, the game
 * is grouped under their co-parent: an album partner is created for the OTHER
 * player (`partnerType: "real"`, name = the co-parent's real display name so it
 * groups stably across games) and the game is linked to that partner.
 *
 * Each player's grouping runs independently and is individually guarded so one
 * player's failure never affects the other. The caller invokes this
 * fire-and-forget; it must never block or throw into the socket handler.
 */
export async function generateMultiplayerAlbums(deps: {
  engine: EndgameEngine;
  repo: GameRepository;
  state: GameState;
  epilogue: string;
  reportCard: string;
  players: MultiplayerAlbumPlayer[];
}): Promise<void> {
  const { engine, repo, state, epilogue, reportCard, players } = deps;
  const loggedIn = players.filter((p) => !!p.userId);
  if (loggedIn.length === 0) return;

  // Shared, once-per-game: album narrative + moments.
  const albumData = await engine.generateAlbumData(state, epilogue, reportCard, undefined);
  const moments = await buildMomentsWithImages(state.id, albumData);
  await repo.saveAlbumMoments(state.id, moments);

  // Per-player: user_games row + album partner (the co-parent) + link.
  await Promise.all(
    loggedIn.map(async (player) => {
      const partner = players.find((p) => p !== player);
      if (!partner) return; // no co-parent to group under
      const userId = player.userId as string;
      try {
        await repo.saveUserGame(userId, state.id, state.childName);
        const partnerId = await repo.saveAlbumPartner({
          userId,
          partnerName: partner.displayName,
          partnerType: "real",
          relationshipSummary: albumData.relationshipSummary,
        });
        await repo.linkGameToPartner(userId, state.id, partnerId);
        logger.info("mp_album_generated", {
          gameId: state.id,
          userId,
          partner: partner.displayName,
          moments: moments.length,
        });
      } catch (e) {
        logger.error("mp_album_player_failed", {
          gameId: state.id,
          userId,
          error: (e as Error).message,
        });
      }
    })
  );
}
