import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import type { GameRepository } from "../db/repository.js";
import { logger } from "../logger.js";
import { CAMPUS_PASS_AUDIENCE, verifyCampusPass } from "../security/campus-pass.js";
import { issueCampusIdentity } from "../security/campus-identity.js";

/**
 * Web cabinets: POST /api/campus-pass { pass } → { identity, name, sub }.
 * The pass is campus's 5-minute signed launch pass; it is verified, consumed
 * (its jti can't be replayed), and never logged or stored — only its jti is
 * logged. The identity is an opaque token the client sends with game
 * create/join (security/campus-identity.ts). The global IP-ban check and
 * rate limit run before this, as for every route.
 */
export function createCampusRoutes(repo: GameRepository, opts: { limit?: RequestHandler } = {}): Router {
  const router = Router();
  router.post("/campus-pass", ...(opts.limit ? [opts.limit] : []), async (req: Request, res: Response) => {
    const pass = (req.body as { pass?: unknown } | undefined)?.pass;
    const verified = typeof pass === "string" ? await verifyCampusPass(pass, { audience: CAMPUS_PASS_AUDIENCE, jtiStore: repo }) : null;
    if (!verified) {
      res.status(400).json({ error: "pass_refused" });
      return;
    }
    let identity: string;
    try {
      identity = await issueCampusIdentity(repo, { sub: verified.sub, name: verified.name });
    } catch (err) {
      // The jti is already spent, so this pass is gone: the client asks
      // campus for a fresh one (mg:ready) and plays anonymously meanwhile.
      logger.error("campus_identity_issue_failed", { jti: verified.jti, error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ error: "campus_identity_unavailable" });
      return;
    }
    logger.info("campus_pass_exchanged", { jti: verified.jti });
    res.json({ identity, name: verified.name, sub: verified.sub });
  });
  return router;
}
