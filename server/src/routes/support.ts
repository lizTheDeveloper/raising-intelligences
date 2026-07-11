import { Router } from "express";
import type { Request, Response } from "express";
import { logger } from "../logger.js";

const CHECKOUT_URL =
  process.env.STRIPE_WEBHOOK_CHECKOUT_URL ?? "https://multiversestudios.xyz/stripe/create-checkout-session";

const MIN_CENTS = 100; // $1
const MAX_CENTS = 100_000; // $1,000

/**
 * Support ("pay what you can") checkout. Proxies server-to-server to the
 * shared stripe-webhook service (ceo/stripe-webhook, GAME_META key
 * "raising_intelligences") so the browser never needs stripe-webhook's
 * ALLOWED_ORIGINS/CSP wired in — this app's own CSP connectSrc stays 'self'.
 */
export function createSupportRoutes(): Router {
  const router = Router();

  router.post("/support/checkout", async (req: Request, res: Response) => {
    const { amount, sourcePage } = req.body as { amount?: number; sourcePage?: string };

    if (!Number.isInteger(amount) || (amount as number) < MIN_CENTS || (amount as number) > MAX_CENTS) {
      res.status(400).json({ error: `amount must be an integer number of cents between ${MIN_CENTS} and ${MAX_CENTS}` });
      return;
    }

    try {
      const upstream = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game: "raising_intelligences",
          amount,
          source_page: sourcePage ?? "epilogue",
        }),
      });

      const data = (await upstream.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!upstream.ok || !data.url) {
        logger.error("support_checkout_upstream_error", { status: upstream.status, error: data.error });
        res.status(502).json({ error: "Could not start checkout" });
        return;
      }

      res.json({ url: data.url });
    } catch (err) {
      logger.error("support_checkout_error", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  return router;
}
