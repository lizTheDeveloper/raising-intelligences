import { Router } from "express";
import type { Request, Response } from "express";
import type { GameRepository } from "../db/repository.js";
import { existsSync } from "fs";
import path from "path";
import { PORTRAITS_DIR } from "../portrait-gen.js";
import { isValidUserId, UUID_RE } from "../lib/validation.js";

const AGE_SLUGS = [
  { age: 3, slug: "age-03" },
  { age: 7, slug: "age-07" },
  { age: 12, slug: "age-12" },
  { age: 16, slug: "age-16" },
  { age: 20, slug: "age-20" },
];

function getPortraitUrls(gameId: string): Array<{ age: number; url: string }> {
  return AGE_SLUGS
    .filter(({ slug }) => existsSync(path.join(PORTRAITS_DIR, gameId, `${slug}.png`)))
    .map(({ age, slug }) => ({ age, url: `portraits/${gameId}/${slug}.png` }));
}

export function createAlbumRoutes(repo: GameRepository): Router {
  const router = Router();

  router.get("/user/:userId/album", async (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    if (!isValidUserId(userId)) {
      res.status(400).json({ error: "Invalid userId format" });
      return;
    }
    const album = await repo.loadAlbum(userId);
    res.json(album);
  });

  router.get("/user/:userId/album/kid/:gameId", async (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    const gameId = req.params.gameId as string;
    if (!isValidUserId(userId)) {
      res.status(400).json({ error: "Invalid userId format" });
      return;
    }
    if (!UUID_RE.test(gameId)) {
      res.status(400).json({ error: "Invalid gameId format" });
      return;
    }
    const scrapbook = await repo.loadScrapbook(userId, gameId);
    if (!scrapbook) {
      res.status(404).json({ error: "Kid not found" });
      return;
    }
    res.json({
      ...scrapbook,
      portraits: getPortraitUrls(gameId),
    });
  });

  return router;
}
