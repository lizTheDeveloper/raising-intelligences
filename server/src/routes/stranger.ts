import express, { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import { logger } from "../logger.js";
import { verifyWebhookSignature } from "../payments/stripe.js";
import { CONSENT_VERSION, type VerificationSession } from "../stranger/identity.js";
import type { StrangerService } from "../stranger/service.js";

export const IDENTITY_WEBHOOK_PATH = "/api/stripe/identity-webhook";

/**
 * Stranger mode over HTTP. With RI_STRANGER_MODE off (the default) every
 * route here answers 404, as if stranger mode didn't exist. In meetup mode,
 * only with a listed ?meetup= code — and a pass stops working the moment its
 * code is taken off the list.
 */
export function createStrangerRoutes(stranger: StrangerService, limit: RequestHandler): Router {
  const router = Router();
  const notFound = (res: Response) => res.status(404).json({ error: "Not found" });

  /** Resolve the caller's pass, or answer for them. */
  const withPass = (req: Request, res: Response): { subject: string; meetupCode: string | null } | null => {
    if (stranger.off()) { notFound(res); return null; }
    const raw = (req.body as { pass?: unknown } | undefined)?.pass;
    const p = stranger.passes.resolve(raw);
    if (!p) { res.status(401).json({ error: "Sign in again." }); return null; }
    if (!stranger.visible(p.meetupCode)) { notFound(res); return null; }
    return p;
  };

  router.get("/stranger/status", (req: Request, res: Response) => {
    if (!stranger.visible(req.query.meetup)) return void notFound(res);
    res.json({ visible: true, consentVersion: CONSENT_VERSION, identityReady: stranger.age.configured() });
  });

  router.post("/stranger/pass", limit, async (req: Request, res: Response) => {
    const { openIdToken, meetup } = (req.body ?? {}) as { openIdToken?: unknown; meetup?: unknown };
    const r = await stranger.issuePass(openIdToken, meetup);
    if ("pass" in r) return void res.json({ pass: r.pass });
    res.status(r.status).json({ error: r.error });
  });

  router.post("/stranger/me", limit, async (req: Request, res: Response) => {
    const p = withPass(req, res);
    if (!p) return;
    res.json(await stranger.me(p.subject));
  });

  router.post("/stranger/consent", limit, async (req: Request, res: Response) => {
    const p = withPass(req, res);
    if (!p) return;
    const ok = await stranger.age.recordConsent(p.subject, String((req.body as { version?: unknown }).version ?? ""));
    if (!ok) return void res.status(400).json({ error: "Please read the current version of this page.", consentVersion: CONSENT_VERSION });
    res.json({ consented: true });
  });

  router.post("/stranger/identity/start", limit, async (req: Request, res: Response) => {
    const p = withPass(req, res);
    if (!p) return;
    try {
      const r = await stranger.age.start(p.subject, p.meetupCode);
      if ("url" in r) return void res.json({ url: r.url });
      const status = { no_consent: 409, minor: 403, rate_limited: 429, not_configured: 503, no_url: 502 }[r.reason] ?? 400;
      res.status(status).json({ error: r.error, reason: r.reason });
    } catch (err) {
      logger.error("stranger_identity_start_failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: "The ID check didn't open. Try again." });
    }
  });

  router.post("/stranger/identity/check", limit, async (req: Request, res: Response) => {
    const p = withPass(req, res);
    if (!p) return;
    try {
      await stranger.age.check(p.subject);
    } catch (err) {
      logger.error("stranger_identity_check_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    res.json(await stranger.me(p.subject));
  });

  return router;
}

/**
 * Stripe Identity's webhook. Its own endpoint and signing secret: the
 * Identity key is a live restricted key while payments may still be in test
 * mode, and Stripe signs each mode's endpoints separately.
 */
export function createIdentityWebhookRoute(stranger: StrangerService): Router {
  const router = Router();
  router.post("/stripe/identity-webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
    const secret = stranger.config().identityWebhookSecret;
    if (!secret) return void res.status(503).json({ error: "webhook not configured" });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!verifyWebhookSignature(raw, req.headers["stripe-signature"] as string | undefined, secret)) {
      logger.warn("identity_webhook_bad_signature");
      return void res.status(400).json({ error: "bad signature" });
    }
    try {
      const event = JSON.parse(raw.toString("utf8")) as { type?: string; data?: { object?: VerificationSession } };
      if (event.type?.startsWith("identity.verification_session.") && event.data?.object) {
        await stranger.age.applyWebhookSession(event.data.object);
      }
      res.json({ received: true });
    } catch (err) {
      logger.error("identity_webhook_error", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "processing failed" });
    }
  });
  return router;
}
