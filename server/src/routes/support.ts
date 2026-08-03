import { Router } from "express";
import type { Request, Response } from "express";
import { logger } from "../logger.js";

/**
 * Shared stripe-webhook checkout endpoint.
 *
 * This used to default to `https://multiversestudios.xyz/stripe/create-checkout-session`,
 * which returns an nginx **404** — that host does not route the /stripe path at
 * all. Every Support ("pay what you can") click therefore failed: the upstream
 * 404 became a 502 to the player and a `support_checkout_upstream_error` in the
 * log. Seen in production 2026-08-03 11:34:16Z, and the same dead URL is called
 * out in docs/analytics/REVIEW-2026-08-02.md, where "0 checkouts in 30d" was
 * shown to be an outage rather than a conversion result.
 *
 * pay.multiversegames.ai is the live endpoint. Verified from the games box with
 * this app's own game key: `{"game":"raising_intelligences",...}` returns 200
 * with a real Stripe checkout URL.
 */
const CHECKOUT_URL =
  process.env.STRIPE_WEBHOOK_CHECKOUT_URL ?? "https://pay.multiversegames.ai/create-checkout-session";

/** Hosts known not to serve the checkout path — guarded by a test. */
export const DEAD_CHECKOUT_HOSTS = ["multiversestudios.xyz"];

/** Exposed so a test can assert we never ship a default that 404s. */
export function getCheckoutUrl(): string {
  return CHECKOUT_URL;
}

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
