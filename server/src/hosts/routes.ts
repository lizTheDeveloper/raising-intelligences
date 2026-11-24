import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import { requireAdmin } from "../routes/admin.js";
import { logger } from "../logger.js";
import type { HostTools } from "./service.js";

/**
 * Host tools over HTTP (spec, build plan B.3). Off — any mode but meetup —
 * every public route falls through with next("router"), like a path that was
 * never built. No response or log line here carries an event code, a share
 * code, a subject or a Matrix id (H11, H21).
 */
export function createHostToolsRoutes(hosts: HostTools, limit: RequestHandler): Router {
  const router = Router();
  const hide = (next: NextFunction) => next("router");
  router.use(["/events"], (_req: Request, _res: Response, next: NextFunction) => (hosts.active() ? next() : hide(next)));

  // The card for an open meetup. Unknown, closed or off: the same 404 as "never built".
  router.get("/events/card", limit, async (req: Request, res: Response, next: NextFunction) => {
    await hosts.ready;
    const card = await hosts.card(req.query.meetup);
    if (!card) return void hide(next);
    res.setHeader("Cache-Control", "no-store");
    res.json({ card });
  });

  // "sounds good, continue": records the acknowledgement; a stale version gets the current card.
  router.post("/events/ack", limit, async (req: Request, res: Response, next: NextFunction) => {
    await hosts.ready;
    const { meetup, cardVersion, pass } = (req.body ?? {}) as { meetup?: unknown; cardVersion?: unknown; pass?: unknown };
    // Signed in already (a card that changed mid-evening): bind at once.
    let subject: string | null = null;
    if (pass !== undefined) {
      const p = await hosts.stranger.resolveLive(pass);
      if (p && p !== "hidden") subject = await hosts.stranger.age.subjectHash(p.subject);
    }
    const r = await hosts.acknowledge(meetup, cardVersion, subject);
    if (r.ok) return void res.json({ ackToken: r.ackToken });
    if (r.status === 404) return void hide(next);
    res.status(409).json({ error: "this meetup's card changed. here's the new one.", card: r.card });
  });

  // "report this host": no account needed. Read by a person; the host isn't told.
  router.post("/events/report-host", limit, async (req: Request, res: Response) => {
    await hosts.ready;
    const { meetup, text } = (req.body ?? {}) as { meetup?: unknown; text?: unknown };
    const clean = typeof text === "string" ? text.replace(/[\u0000-\u0008\u000b-\u001f\u007f<>]/g, " ").trim().slice(0, 2000) : "";
    if (!clean) return void res.status(400).json({ error: "tell the studio what happened." });
    const e = hosts.eventForCode(meetup);
    await hosts.store.addHostReport({ id: randomUUID(), eventId: e?.id ?? null, text: clean, at: hosts.now(), status: "open" });
    logger.warn("host_report_filed", { withEvent: !!e });
    res.json({ ok: true });
  });

  return router;
}

/**
 * Liz's admin for the prototype (ADMIN_TOKEN). Creating people and events
 * needs meetup mode on (it needs the stranger pepper and the 18+ check); the
 * review queues work whatever the mode.
 */
export function createHostToolsAdminRoutes(hosts: HostTools): Router {
  const router = Router();
  router.use("/admin/host-tools", requireAdmin, (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const send = <T>(res: Response, r: { ok: true; value: T } | { ok: false; status: number; error: string }, map: (v: T) => unknown = (v) => v) =>
    r.ok ? res.json(map(r.value)) : res.status(r.status).json({ error: r.error });
  const personView = ({ subject: _s, ...p }: Record<string, unknown> & { subject: string }) => p;

  router.get("/admin/host-tools/status", async (_req: Request, res: Response) => {
    await hosts.ready;
    const c = hosts.config();
    res.json({ active: hosts.active(), shareCodeSecret: !!c.shareCodeSecret, traceRetentionDays: c.traceRetentionDays, traceWhere: c.traceWhere, paywallOn: hosts.payments.active() });
  });

  router.get("/admin/host-tools/hosts", async (_req: Request, res: Response) => {
    res.json({ people: (await hosts.store.listPeople()).map((p) => personView(p as never)) });
  });
  // Create a host or guest reader: {matrixId, displayName, roleText?, roleChecked?, agreementVersion?}.
  // Only the HMAC subject is stored, never the Matrix id.
  router.post("/admin/host-tools/hosts", async (req: Request, res: Response) => {
    await hosts.ready;
    if (!hosts.active()) return void res.status(503).json({ error: "host tools are off (RI_STRANGER_MODE isn't meetup)" });
    send(res, await hosts.createPerson((req.body ?? {}) as Record<string, unknown>), (p) => personView(p as never));
  });
  // The host type (§9.1), set once: {hostType, organisation?}. See HostTools.setPersonType.
  router.post("/admin/host-tools/hosts/:id/type", async (req: Request, res: Response) => {
    await hosts.ready;
    send(res, await hosts.setPersonType(String(req.params.id), (req.body ?? {}) as Record<string, unknown>), (p) => personView(p as never));
  });
  router.post("/admin/host-tools/hosts/:id/status", async (req: Request, res: Response) => {
    send(res, await hosts.setPersonStatus(String(req.params.id), (req.body as { status?: unknown } | undefined)?.status), (p) => personView(p as never));
  });

  router.get("/admin/host-tools/events", async (_req: Request, res: Response) => {
    await hosts.ready;
    res.json({ events: await Promise.all(hosts.listCached().sort((a, b) => b.createdAt - a.createdAt).map((e) => hosts.adminView(e))) });
  });
  // Returns the plaintext event code ONCE. It is never stored or shown again.
  router.post("/admin/host-tools/events", async (req: Request, res: Response) => {
    await hosts.ready;
    const r = await hosts.createEvent((req.body ?? {}) as Record<string, unknown>);
    if (!r.ok) return void res.status(r.status).json({ error: r.error });
    res.json({ event: await hosts.adminView(r.value.event), code: r.value.code, link: `?meetup=${r.value.code}` });
  });

  // The event's link again, and a new one (the old code stops at once).
  router.get("/admin/host-tools/events/:id/link", async (req: Request, res: Response) => {
    await hosts.ready;
    const e = hosts.eventById(String(req.params.id));
    if (!e) return void res.status(404).json({ error: "No such event" });
    res.json(hosts.codeFor(e) ?? { link: null, code: null });
  });
  router.post("/admin/host-tools/events/:id/new-link", async (req: Request, res: Response) => {
    await hosts.ready;
    send(res, await hosts.newCode(String(req.params.id)));
  });
  router.patch("/admin/host-tools/events/:id", async (req: Request, res: Response) => {
    await hosts.ready;
    const r = await hosts.patchEvent(String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
    if (!r.ok) return void res.status(r.status).json({ error: r.error });
    res.json({ event: await hosts.adminView(r.value) });
  });

  router.get("/admin/host-tools/host-reports", async (_req: Request, res: Response) => {
    res.json({ reports: await hosts.store.listHostReports() });
  });
  router.post("/admin/host-tools/host-reports/:id/done", async (req: Request, res: Response) => {
    const ok = await hosts.store.setHostReportStatus(String(req.params.id), "done");
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "No such report" });
  });

  return router;
}
