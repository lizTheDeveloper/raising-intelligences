import express, { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import type { GameRepository } from "../db/repository.js";
import type { Session } from "../game/session-manager.js";
import type { PartnerPayments } from "../payments/partner-payments.js";
import { withGameLock } from "../lib/game-lock.js";
import { UUID_RE } from "../lib/validation.js";
import { logger } from "../logger.js";
import { requireAdmin } from "./admin.js";

/** Mounted before the global JSON parser sees it: the signature is over the raw bytes. */
export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";

const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

interface Options {
  payments: PartnerPayments;
  repo: GameRepository;
  sessions: Map<string, Session>;
  gameLocks: Map<string, Promise<void>>;
  limit?: RequestHandler;
}

/**
 * The host's side of the $20 per-child payment, plus Stripe's webhook and the
 * admin refund. See payments/partner-payments.ts for the rules.
 */
export function createPartnerPaymentRoutes({ payments, repo, sessions, gameLocks, limit }: Options): Router {
  const router = Router();
  const limited = limit ? [limit] : [];

  /** Is `token` the host (parent1) seat's reconnect token for this game? */
  async function isHost(gameId: string, token: unknown): Promise<boolean> {
    if (typeof token !== "string" || token.length < 10 || token.length > 200) return false;
    const live = sessions.get(gameId)?.players.find((p) => p.slot === "parent1");
    if (live) return safeEqual(live.token, token);
    const stored = (await repo.loadPlayers(gameId)).find((p) => p.slot === "parent1");
    return !!stored && safeEqual(stored.token, token);
  }

  router.post("/partner-payment/checkout", ...limited, async (req: Request, res: Response) => {
    const { gameId, playerToken } = (req.body ?? {}) as { gameId?: unknown; playerToken?: unknown };
    if (typeof gameId !== "string" || !UUID_RE.test(gameId)) {
      res.status(400).json({ error: "gameId is required" });
      return;
    }
    try {
      if (!(await isHost(gameId, playerToken))) {
        res.status(403).json({ error: "Only the host pays for this child." });
        return;
      }
      // Under the game lock: two clicks (two tabs, a double-tap) serialize, so
      // the second one finds and reuses the first one's session.
      const result = await withGameLock(gameLocks, gameId, () => payments.checkoutUrl(gameId));
      if ("url" in result) {
        res.json({ url: result.url });
        return;
      }
      res.status(result.status).json({ error: result.error, ...(result.alreadyPaid ? { alreadyPaid: true } : {}) });
    } catch (err) {
      logger.error("partner_checkout_error", { gameId, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: "Could not start checkout. Try again." });
    }
  });

  router.post("/partner-payment/confirm", ...limited, async (req: Request, res: Response) => {
    const { gameId, sessionId } = (req.body ?? {}) as { gameId?: unknown; sessionId?: unknown };
    if (typeof gameId !== "string" || !UUID_RE.test(gameId) || typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      res.status(400).json({ error: "gameId and sessionId are required" });
      return;
    }
    try {
      const result = await withGameLock(gameLocks, gameId, () => payments.confirm(gameId, sessionId));
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error("partner_confirm_error", { gameId, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: "Could not confirm the payment yet." });
    }
  });

  router.post("/admin/games/:id/refund", requireAdmin, async (req: Request, res: Response) => {
    const gameId = req.params.id as string;
    if (!UUID_RE.test(gameId)) {
      res.status(400).json({ error: "bad game id" });
      return;
    }
    try {
      const result = await withGameLock(gameLocks, gameId, () => payments.adminRefund(gameId));
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error("partner_refund_error", { gameId, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: "Refund failed; check the Stripe dashboard." });
    }
  });

  return router;
}

/** Stripe → RI. Raw body, signature checked before anything is parsed. */
export function createStripeWebhookRoute(payments: PartnerPayments): Router {
  const router = Router();
  router.post("/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    try {
      const result = await payments.handleWebhook(raw, req.headers["stripe-signature"] as string | undefined);
      res.status(result.status).json(result.body);
    } catch (err) {
      // 500 → Stripe redelivers; every handler is idempotent.
      logger.error("stripe_webhook_error", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "processing failed" });
    }
  });
  return router;
}
