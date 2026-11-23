import express, { Router } from "express";
import type { Request, Response, RequestHandler, NextFunction } from "express";
import { logger } from "../logger.js";
import { verifyWebhookSignature } from "../payments/stripe.js";
import { CONSENT_VERSION, type VerificationSession } from "../stranger/identity.js";
import type { StrangerService } from "../stranger/service.js";

export const IDENTITY_WEBHOOK_PATH = "/api/stripe/identity-webhook";

/**
 * Stranger mode over HTTP. With RI_STRANGER_MODE off (the default) every
 * route here falls through — next("router") — to whatever answers a path
 * that doesn't exist, so "off" is indistinguishable from "never built". In
 * meetup mode, only with a listed ?meetup= code; a pass stops working the
 * moment its code is no longer listed.
 */
export function createStrangerRoutes(stranger: StrangerService, limit: RequestHandler): Router {
  const router = Router();
  const hide = (next: NextFunction) => next("router");
  router.use((_req: Request, _res: Response, next: NextFunction) => (stranger.off() ? hide(next) : next()));

  /** Resolve the caller's pass, or answer for them (null = already answered). */
  const withPass = async (req: Request, res: Response, next: NextFunction): Promise<{ subject: string; meetupCode: string | null } | null> => {
    const raw = (req.body as { pass?: unknown } | undefined)?.pass;
    const p = await stranger.resolveLive(raw);
    if (p === "hidden") { hide(next); return null; }
    if (!p) { res.status(401).json({ error: "Sign in again." }); return null; }
    return p;
  };

  router.get("/stranger/status", (req: Request, res: Response, next: NextFunction) => {
    if (!stranger.visible(req.query.meetup)) return void hide(next);
    res.json({ visible: true, consentVersion: CONSENT_VERSION, identityReady: stranger.age.configured() });
  });

  router.post("/stranger/pass", limit, async (req: Request, res: Response, next: NextFunction) => {
    const { openIdToken, meetup } = (req.body ?? {}) as { openIdToken?: unknown; meetup?: unknown };
    if (!stranger.visible(meetup)) return void hide(next);
    const r = await stranger.issuePass(openIdToken, meetup, req.ip ?? undefined);
    if ("pass" in r) return void res.json({ pass: r.pass });
    res.status(r.status).json({ error: r.error });
  });

  router.post("/stranger/me", limit, async (req: Request, res: Response, next: NextFunction) => {
    const p = await withPass(req, res, next);
    if (!p) return;
    res.json(await stranger.me(p.subject));
  });

  router.post("/stranger/consent", limit, async (req: Request, res: Response, next: NextFunction) => {
    const p = await withPass(req, res, next);
    if (!p) return;
    const ok = await stranger.age.recordConsent(p.subject, String((req.body as { version?: unknown }).version ?? ""));
    if (!ok) return void res.status(400).json({ error: "Please read the current version of this page.", consentVersion: CONSENT_VERSION });
    res.json({ consented: true });
  });

  router.post("/stranger/identity/start", limit, async (req: Request, res: Response, next: NextFunction) => {
    const p = await withPass(req, res, next);
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

  router.post("/stranger/identity/check", limit, async (req: Request, res: Response, next: NextFunction) => {
    const p = await withPass(req, res, next);
    if (!p) return;
    try {
      await stranger.age.check(p.subject);
    } catch (err) {
      logger.error("stranger_identity_check_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    res.json(await stranger.me(p.subject));
  });

  // ---- The queue ----
  const clean = (v: unknown, max: number): string =>
    typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max) : "";

  router.post("/stranger/queue/join", limit, async (req: Request, res: Response, next: NextFunction) => {
    const p = await withPass(req, res, next);
    if (!p) return;
    const m = stranger.matching;
    if (!m) return void res.status(503).json({ error: "Matching isn't running." });
    const body = req.body as { childName?: unknown; displayName?: unknown };
    const childName = clean(body.childName, 40);
    if (!childName) return void res.status(400).json({ error: "Name the child you'd like to raise." });
    const displayName = clean(body.displayName, 30) || "a parent";
    const r = await m.join(p.subject, p.meetupCode, displayName, childName);
    if (!r.ok) return void res.status(r.status).json({ error: r.error });
    res.json(m.poll(p.subject));
  });

  router.post("/stranger/queue/poll", limit, async (req: Request, res: Response, next: NextFunction) => {
    const p = await withPass(req, res, next);
    if (!p) return;
    res.json(stranger.matching?.poll(p.subject) ?? { status: "none" });
  });

  router.post("/stranger/queue/leave", limit, async (req: Request, res: Response, next: NextFunction) => {
    const p = await withPass(req, res, next);
    if (!p) return;
    stranger.matching?.leave(p.subject);
    res.json({ status: "none" });
  });

  router.post("/stranger/queue/requeue", limit, async (req: Request, res: Response, next: NextFunction) => {
    const p = await withPass(req, res, next);
    if (!p) return;
    const gameId = (req.body as { gameId?: unknown }).gameId;
    const ok = typeof gameId === "string" && (await stranger.matching?.requeue(p.subject, gameId));
    if (!ok) return void res.status(409).json({ error: "Nothing to requeue from." });
    res.json(stranger.matching!.poll(p.subject));
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
  router.post(
    "/stripe/identity-webhook",
    // Off: fall through like any unknown path.
    (_req: Request, _res: Response, next: NextFunction) => (stranger.off() ? next("router") : next()),
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req: Request, res: Response) => {
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
  },
  );
  return router;
}
