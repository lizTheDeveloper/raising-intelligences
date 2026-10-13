import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import type { AdminQueries } from "../db/admin-queries.js";
import type { GameRepository } from "../db/repository.js";
import { logger } from "../logger.js";

// Plain `!==` short-circuits at the first differing byte, leaking a
// prefix-match timing oracle on the shared admin secret. Compare in
// constant time instead.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

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

/** Parses a query-string bound, falling back to `def` for anything
 * non-numeric or negative, and capping at `max` so a caller can't pull an
 * unbounded result set into memory in one response. */
function parseBound(v: unknown, def: number, max: number): number {
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
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

  // ── Moderation review queue ──────────────────────────────────────────
  // Lists flagged sessions: per-message checks and scene-level "block"
  // verdicts both persist to moderation_flags. Scene-level "concern"
  // verdicts never land here — those are logged separately in
  // concern_events (never a ban, session continues; see recordConcern in
  // safety/moderation.ts) and are not part of this review queue.
  // Enriches each flag with the current ban state of its IP, so a human
  // can review and one-click ban/unban. See safety/moderation.ts.
  router.get("/admin/moderation-flags", async (req: Request, res: Response) => {
    try {
      const limit = parseBound(req.query.limit, 100, 200);
      const offset = parseBound(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
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
