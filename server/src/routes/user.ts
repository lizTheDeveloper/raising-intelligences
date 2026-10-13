import { Router } from "express";
import type { Request, Response } from "express";
import { query } from "../db/pool.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";

const MAX_USER_ID_LENGTH = 300;

function isValidUserId(id: string): boolean {
  if (!id || id.length > MAX_USER_ID_LENGTH) return false;
  // Accept Matrix IDs (@user:server) or UUIDs — both are the formats the client sends.
  const MATRIX_ID_RE = /^@[^:]{1,200}:[a-zA-Z0-9.\-]{1,200}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return MATRIX_ID_RE.test(id) || UUID_RE.test(id);
}

/**
 * @param games The authoritative in-memory game-state cache shared with the
 * game/socket routes (see app.ts). Deleting a user's data must also evict
 * any of their games from this cache, or a game deleted from the repository
 * could still be served from memory until eviction/restart.
 */
export function createUserRoutes(repo: GameRepository, games: Map<string, GameState>): Router {
  const router = Router();

  router.get("/user/:userId/kids", async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    if (!isValidUserId(userId)) {
      res.status(400).json({ error: "Invalid userId format" });
      return;
    }
    const result = await query<{ game_id: string; child_name: string; created_at: string }>(
      "SELECT game_id, child_name, created_at FROM user_games WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    res.json(
      result.rows.map((r) => ({
        gameId: r.game_id,
        childName: r.child_name,
        createdAt: new Date(r.created_at).getTime(),
      }))
    );
  });

  router.post("/user/:userId/kids", async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    if (!isValidUserId(userId)) {
      res.status(400).json({ error: "Invalid userId format" });
      return;
    }
    const kids = req.body as Array<{ gameId: string; childName: string }>;
    if (!Array.isArray(kids)) {
      res.status(400).json({ error: "body must be an array of {gameId, childName}" });
      return;
    }
    for (const kid of kids) {
      if (!kid.gameId || !kid.childName) continue;
      await query(
        `INSERT INTO user_games (user_id, game_id, child_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, game_id) DO NOTHING`,
        [userId, kid.gameId, kid.childName]
      );
    }
    res.json({ synced: kids.length });
  });

  // Data-subject erasure (issue #141): deletes every game linked to this
  // userId (and that game's messages/events/album/etc. via cascade), plus
  // this user's album partners. See GameRepository.deleteUserData for the
  // exact scope and its limitations.
  router.delete("/user/:userId", async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    if (!isValidUserId(userId)) {
      res.status(400).json({ error: "Invalid userId format" });
      return;
    }
    const { deletedGameIds } = await repo.deleteUserData(userId);
    for (const gameId of deletedGameIds) {
      games.delete(gameId);
    }
    res.json({ deletedGameIds });
  });

  return router;
}
