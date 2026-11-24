import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { requireAdmin } from "../routes/admin.js";
import { logger } from "../logger.js";
import { HOST_CONSENT_VERSION } from "../stranger/identity.js";
import { inviteTokenHash } from "./codes.js";
import { HOST_TYPE_REQUIRED, parseHostType, type HostTools } from "./service.js";
import { HOST_TERMS_VERSION, hostTerms } from "./terms.js";
import type { HostInvite } from "./types.js";

/**
 * Host onboarding by invite (persona tests, S2-5). The admin makes an invite
 * for a named host or guest reader; its link (?hostinvite=<token>) takes the
 * person through Matrix sign-in, the same 18+ check as players (with copy for
 * hosts), and the host terms. Only on agreeing do they become a host_people
 * row, with that agreement recorded, and their portal opens. No meetup card,
 * no acknowledgement, no queue on the way.
 *
 * The token is shown to the admin once and kept only as a keyed hash. Every
 * unknown, used, expired or revoked token gets the same answer.
 */

export const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;
export const INVITE_NOT_AVAILABLE = "this invite isn't available.";
const PASS_TTL_MS = 2 * 3600 * 1000;

type InviteState = "open" | "used" | "expired" | "revoked";

export class InviteService {
  private passes = new Map<string, { mxid: string; inviteId: string; expiresAt: number }>();

  constructor(private readonly hosts: HostTools) {}

  private hash(token: unknown): string | null {
    return typeof token === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(token) ? inviteTokenHash(this.hosts.pepperForInvites(), token) : null;
  }

  state(i: HostInvite): InviteState {
    if (i.revokedAt !== null) return "revoked";
    if (i.usedAt !== null) return "used";
    if (this.hosts.now() >= i.expiresAt) return "expired";
    return "open";
  }

  async open(token: unknown): Promise<HostInvite | null> {
    const h = this.hash(token);
    const i = h ? await this.hosts.store.inviteByHash(h) : null;
    return i && this.state(i) === "open" ? i : null;
  }

  async create(input: { displayName?: unknown; hostType?: unknown; organisation?: unknown }): Promise<{ ok: true; invite: HostInvite; token: string; link: string } | { ok: false; status: number; error: string }> {
    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (!displayName || displayName.length > 60) return { ok: false, status: 400, error: "displayName: 1 to 60 characters" };
    const hostType = parseHostType(input.hostType);
    if (!hostType) return { ok: false, status: 400, error: HOST_TYPE_REQUIRED };
    const organisation = typeof input.organisation === "string" && input.organisation.trim() ? input.organisation.trim().slice(0, 60) : null;
    const token = randomBytes(24).toString("base64url");
    const now = this.hosts.now();
    const invite: HostInvite = {
      id: randomUUID(), tokenHash: inviteTokenHash(this.hosts.pepperForInvites(), token), displayName, hostType, organisation,
      createdAt: now, expiresAt: now + INVITE_TTL_MS, usedAt: null, personId: null, revokedAt: null,
    };
    await this.hosts.store.createInvite(invite);
    logger.info("host_invite_created", { id: invite.id, hostType });
    return { ok: true, invite, token, link: `${this.hosts.stranger.config().publicBaseUrl}/?hostinvite=${token}` };
  }

  issuePass(mxid: string, inviteId: string): string {
    const now = this.hosts.now();
    for (const [t, p] of this.passes) if (p.expiresAt <= now || p.mxid === mxid) this.passes.delete(t);
    const token = randomBytes(32).toString("base64url");
    this.passes.set(token, { mxid, inviteId, expiresAt: now + PASS_TTL_MS });
    return token;
  }

  resolvePass(token: unknown): { mxid: string; inviteId: string } | null {
    if (typeof token !== "string") return null;
    const p = this.passes.get(token);
    if (!p) return null;
    if (p.expiresAt <= this.hosts.now()) { this.passes.delete(token); return null; }
    return { mxid: p.mxid, inviteId: p.inviteId };
  }

  dropPass(token: string): void { this.passes.delete(token); }

  async status(mxid: string): Promise<{ adult: boolean; consented: boolean }> {
    const age = this.hosts.stranger.age;
    return { adult: (await age.adultForPool(mxid)).ok, consented: await age.hasConsent(mxid) };
  }
}

export function createHostInviteRoutes(hosts: HostTools, invites: InviteService, limit: RequestHandler): Router {
  const router = Router();
  router.use("/host/invite", (_req: Request, res: Response, next: NextFunction) => {
    if (!hosts.active()) return next("router");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const notAvailable = (res: Response) => void res.status(404).json({ error: INVITE_NOT_AVAILABLE });
  const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

  /** The open invite behind a live invite pass, or null (the pass or the invite is gone). */
  const withInvite = async (req: Request, res: Response) => {
    await hosts.ready;
    const p = invites.resolvePass(body(req).invitePass);
    if (!p) { notAvailable(res); return null; }
    const all = await hosts.store.listInvites();
    const invite = all.find((i) => i.id === p.inviteId) ?? null;
    if (!invite || invites.state(invite) !== "open") { notAvailable(res); return null; }
    return { ...p, invite };
  };

  router.post("/host/invite/peek", limit, async (req: Request, res: Response) => {
    await hosts.ready;
    const i = await invites.open(body(req).invite);
    if (!i) return notAvailable(res);
    res.json({ displayName: i.displayName, hostType: i.hostType, terms: hostTerms(i.hostType), consentVersion: HOST_CONSENT_VERSION });
  });

  router.post("/host/invite/pass", limit, async (req: Request, res: Response) => {
    await hosts.ready;
    const i = await invites.open(body(req).invite);
    if (!i) return notAvailable(res);
    const mxid = await hosts.stranger.verifyMatrix(body(req).openIdToken);
    if (!mxid) return void res.status(401).json({ error: "sign in with your multiversegames.ai account first." });
    const pool = await hosts.stranger.age.adultForPool(mxid);
    if (pool.reason === "minor" || pool.reason === "banned") {
      return void res.status(403).json({ error: "this account can't host or read at RI meetups.", ...(pool.reason === "minor" ? { minor: true } : {}) });
    }
    if (await hosts.store.personBySubject(await hosts.stranger.age.subjectHash(mxid))) {
      return void res.status(409).json({ error: "this account is already a host or guest reader here. sign in to your page instead." });
    }
    res.json({ invitePass: invites.issuePass(mxid, i.id), ...(await invites.status(mxid)) });
  });

  router.post("/host/invite/consent", limit, async (req: Request, res: Response) => {
    const p = await withInvite(req, res);
    if (!p) return;
    if (body(req).version !== HOST_CONSENT_VERSION || !(await hosts.stranger.age.recordConsent(p.mxid, HOST_CONSENT_VERSION))) {
      return void res.status(400).json({ error: "please read the current version of this page.", consentVersion: HOST_CONSENT_VERSION });
    }
    res.json(await invites.status(p.mxid));
  });

  router.post("/host/invite/identity/start", limit, async (req: Request, res: Response) => {
    const p = await withInvite(req, res);
    if (!p) return;
    try {
      const r = await hosts.stranger.age.start(p.mxid, null, { hostInvite: true });
      if ("url" in r) return void res.json({ url: r.url });
      const status = { no_consent: 409, minor: 403, rate_limited: 429, not_configured: 503, no_url: 502 }[r.reason] ?? 400;
      res.status(status).json({ error: r.error, reason: r.reason });
    } catch (err) {
      logger.error("host_invite_identity_start_failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: "the ID check didn't open. try again." });
    }
  });

  router.post("/host/invite/identity/check", limit, async (req: Request, res: Response) => {
    const p = await withInvite(req, res);
    if (!p) return;
    try {
      await hosts.stranger.age.check(p.mxid);
    } catch (err) {
      logger.error("host_invite_identity_check_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    const pool = await hosts.stranger.age.adultForPool(p.mxid);
    res.json({ ...(await invites.status(p.mxid)), ...(pool.reason === "minor" ? { minor: true } : {}) });
  });

  router.post("/host/invite/accept", limit, async (req: Request, res: Response) => {
    const p = await withInvite(req, res);
    if (!p) return;
    // Age verification stays mandatory: no terms, no person, before the 18+ check passes.
    if (!(await hosts.stranger.age.adultForPool(p.mxid)).ok) return void res.status(403).json({ error: "finish the 18+ check first." });
    if (body(req).termsVersion !== HOST_TERMS_VERSION) {
      return void res.status(409).json({ error: "the terms changed. here are the current ones.", terms: hostTerms(p.invite.hostType) });
    }
    const person = await hosts.createInvitedPerson(p.mxid, p.invite, HOST_TERMS_VERSION);
    if (!person) return void res.status(409).json({ error: "this account is already a host or guest reader here. sign in to your page instead." });
    if (!(await hosts.store.useInvite(p.invite.id, person.id, hosts.now()))) {
      // Someone else used it first (a forwarded link): this person doesn't stay.
      await hosts.store.updatePerson(person.id, { status: "closed" });
      return notAvailable(res);
    }
    invites.dropPass(String(body(req).invitePass));
    logger.info("host_invite_used", { id: p.invite.id });
    res.json({ ok: true });
  });

  return router;
}

export function createHostInviteAdminRoutes(hosts: HostTools, invites: InviteService): Router {
  const router = Router();
  router.use("/admin/host-tools/invites", requireAdmin, (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Returns the token ONCE, in the link. Only its hash is kept.
  router.post("/admin/host-tools/invites", async (req: Request, res: Response) => {
    await hosts.ready;
    const r = await invites.create((req.body ?? {}) as Record<string, unknown>);
    if (!r.ok) return void res.status(r.status).json({ error: r.error });
    const { tokenHash: _h, ...invite } = r.invite;
    res.json({ invite, token: r.token, link: r.link });
  });

  router.get("/admin/host-tools/invites", async (_req: Request, res: Response) => {
    await hosts.ready;
    const people = new Map((await hosts.store.listPeople()).map((p) => [p.id, p.displayName]));
    res.json({
      invites: (await hosts.store.listInvites()).map(({ tokenHash: _h, ...i }) => ({
        ...i, status: invites.state({ tokenHash: "", ...i }), personName: i.personId ? people.get(i.personId) ?? null : null,
      })),
    });
  });

  router.post("/admin/host-tools/invites/:id/revoke", async (req: Request, res: Response) => {
    await hosts.ready;
    const i = (await hosts.store.listInvites()).find((x) => x.id === String(req.params.id));
    if (!i) return void res.status(404).json({ error: "No such invite" });
    if (i.usedAt !== null) return void res.status(409).json({ error: "This invite was already used." });
    await hosts.store.updateInvite(i.id, { revokedAt: hosts.now() });
    res.json({ ok: true });
  });

  return router;
}
