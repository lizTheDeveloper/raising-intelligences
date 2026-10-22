import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { GameRepository } from "../db/repository.js";

export const GAME_SECRET_HEADER = "x-game-secret";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A fresh per-game secret. Only the hash is ever stored; the plaintext is
 * returned to the creating client once and never logged. */
export function newGameSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("hex");
  return { secret, hash: sha256Hex(secret) };
}

export function verifyGameSecret(secret: string | undefined, hash: string | null): boolean {
  if (!secret || !hash) return false;
  const given = Buffer.from(sha256Hex(secret), "utf8");
  const expected = Buffer.from(hash, "utf8");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** Gate for routes with an `:id` param. Games without a stored hash (legacy
 * games) are always refused. */
export function requireGameSecret(repo: GameRepository): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header(GAME_SECRET_HEADER);
    const gameId = req.params.id as string;
    repo
      .getAccessSecretHash(gameId)
      .then((hash) => {
        if (verifyGameSecret(header, hash)) {
          next();
        } else {
          res.status(403).json({ error: "Forbidden" });
        }
      })
      .catch(next);
  };
}
