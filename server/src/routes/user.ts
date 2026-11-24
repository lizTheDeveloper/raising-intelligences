import { Router } from "express";
import type { Request, Response } from "express";
import type { GameRepository } from "../db/repository.js";
import { isValidUserId, UUID_RE } from "../lib/validation.js";
import { verifyGameSecret } from "../security/game-secret.js";
import { requireMatrixUser, type MatrixVerifier, type SeatOf } from "../security/game-read-access.js";

/**
 * A signed-in player's kid list, for resuming on another device.
 *
 * Privacy review F1: both routes were open to anyone who knew a Matrix id.
 * Now the caller must be signed in as that user (a Matrix OpenID token in
 * x-matrix-openid, checked against the homeserver). A synced kid carries
 * proof of access when the device has it (the game's secret, or its seat
 * token); only a proven row lets its owner read the game later.
 */
export function createUserRoutes(repo: GameRepository, deps: { verifyMatrix: MatrixVerifier; seatOf: SeatOf }): Router {
  const router = Router();
  const owner = requireMatrixUser(deps.verifyMatrix);

  const validUser = (req: Request, res: Response): boolean => {
    if (isValidUserId(String(req.params.userId))) return true;
    res.status(400).json({ error: "Invalid userId format" });
    return false;
  };

  router.get("/user/:userId/kids", owner, async (req: Request, res: Response) => {
    if (!validUser(req, res)) return;
    res.json(await repo.listUserKids(String(req.params.userId)));
  });

  router.post("/user/:userId/kids", owner, async (req: Request, res: Response) => {
    if (!validUser(req, res)) return;
    const userId = String(req.params.userId);
    const kids = req.body as Array<{ gameId?: unknown; childName?: unknown; secret?: unknown; playerToken?: unknown }>;
    if (!Array.isArray(kids)) {
      res.status(400).json({ error: "body must be an array of {gameId, childName}" });
      return;
    }
    for (const kid of kids) {
      if (typeof kid?.gameId !== "string" || !UUID_RE.test(kid.gameId) || typeof kid.childName !== "string" || !kid.childName) continue;
      const proven =
        (typeof kid.secret === "string" && verifyGameSecret(kid.secret, await repo.getAccessSecretHash(kid.gameId))) ||
        (typeof kid.playerToken === "string" && kid.playerToken.length > 0 && (await deps.seatOf(kid.gameId, kid.playerToken)).slot !== null);
      try {
        await repo.saveUserGame(userId, kid.gameId, kid.childName, proven);
      } catch (err) {
        // A game id that no longer exists (deleted) breaks the row's foreign key: skip that one kid.
        if ((err as { code?: string }).code !== "23503") throw err;
      }
    }
    res.json({ synced: kids.length });
  });

  return router;
}
