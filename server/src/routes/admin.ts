import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AdminQueries } from "../db/admin-queries.js";
import type { GameRepository } from "../db/repository.js";
import { logger } from "../logger.js";

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

export function createAdminRoutes(adminQueries: AdminQueries, repo: GameRepository): Router {
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
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
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

  // ── Moderation review queue ──────────────────────────────────────────
  // Lists flagged sessions (both the per-message and scene-level checks
  // persist here) and enriches each with the current ban state of its IP,
  // so a human can review and one-click ban/unban. See safety/moderation.ts.
  router.get("/admin/moderation-flags", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
      const { flags, total } = await adminQueries.listModerationFlags({ limit, offset });

      // Ban state lives in banned_ips (the repo), not the flags table — enrich
      // once per distinct IP so the UI can show/toggle it.
      const distinctIps = [...new Set(flags.map((f) => f.ipAddress).filter((ip): ip is string => !!ip))];
      const bannedIps = new Set<string>();
      await Promise.all(
        distinctIps.map(async (ip) => {
          if (await repo.isIpBanned(ip)) bannedIps.add(ip);
        })
      );

      res.json({
        total,
        flags: flags.map((f) => ({
          ...f,
          banned: f.ipAddress ? bannedIps.has(f.ipAddress) : false,
        })),
      });
    } catch (err) {
      logger.error("admin_moderation_flags_error", { error: String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/admin/moderation/ban", async (req: Request, res: Response) => {
    try {
      const ip = (req.body as { ip?: unknown })?.ip;
      const reason = (req.body as { reason?: unknown })?.reason;
      if (typeof ip !== "string" || ip.trim() === "") {
        res.status(400).json({ error: "ip is required" });
        return;
      }
      const banReason = typeof reason === "string" && reason.trim() !== "" ? reason : "admin_manual";
      await repo.banIp(ip, banReason);
      logger.warn("admin_ban_ip", { ip, reason: banReason });
      res.json({ ok: true, ip, banned: true });
    } catch (err) {
      logger.error("admin_ban_ip_error", { error: String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/admin/moderation/unban", async (req: Request, res: Response) => {
    try {
      const ip = (req.body as { ip?: unknown })?.ip;
      if (typeof ip !== "string" || ip.trim() === "") {
        res.status(400).json({ error: "ip is required" });
        return;
      }
      await repo.unbanIp(ip);
      logger.warn("admin_unban_ip", { ip });
      res.json({ ok: true, ip, banned: false });
    } catch (err) {
      logger.error("admin_unban_ip_error", { error: String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
