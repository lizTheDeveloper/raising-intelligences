import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AdminQueries } from "../db/admin-queries.js";
import { logger } from "../logger.js";
import { safeEqual } from "../lib/safe-equal.js";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    res.status(503).json({ error: "Admin not configured" });
    return;
  }
  const header = req.headers.authorization;
  if (!header || !safeEqual(header, `Bearer ${token}`)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function parseBound(v: unknown, def: number, max: number): number {
  if (v === undefined) return def;
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

export function createAdminRoutes(adminQueries: AdminQueries): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/admin/overview", async (_req: Request, res: Response) => {
    try {
      const stats = await adminQueries.getOverview();
      res.json(stats);
    } catch (err) {
      logger.error("admin_overview_error", { error: String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/admin/games", async (req: Request, res: Response) => {
    try {
      const status = req.query.status as "active" | "completed" | "abandoned" | undefined;
      const limit = parseBound(req.query.limit, 50, 200);
      const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
      const result = await adminQueries.listGames({ status, limit, offset });
      res.json(result);
    } catch (err) {
      logger.error("admin_games_list_error", { error: String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/admin/games/:id", async (req: Request, res: Response) => {
    try {
      const detail = await adminQueries.getGameDetail(req.params.id as string);
      if (!detail) {
        res.status(404).json({ error: "Game not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      logger.error("admin_game_detail_error", { error: String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
