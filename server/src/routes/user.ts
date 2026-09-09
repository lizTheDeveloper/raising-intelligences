import { Router } from "express";
import type { Request, Response } from "express";
import { query } from "../db/pool.js";
import { isValidUserId } from "../lib/validation.js";

export function createUserRoutes(): Router {
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

  return router;
}
