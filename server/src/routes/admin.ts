import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AdminQueries } from "../db/admin-queries.js";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    res.status(503).json({ error: "Admin not configured" });
    return;
  }
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${token}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function createAdminRoutes(adminQueries: AdminQueries): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/admin/overview", async (_req: Request, res: Response) => {
    try {
      const stats = await adminQueries.getOverview();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/admin/games", async (req: Request, res: Response) => {
    try {
      const status = req.query.status as "active" | "completed" | "abandoned" | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
      const result = await adminQueries.listGames({ status, limit, offset });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/admin/games/:id", async (req: Request, res: Response) => {
    try {
      const detail = await adminQueries.getGameDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "Game not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
