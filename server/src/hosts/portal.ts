import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { requireAdmin } from "../routes/admin.js";
import { logger } from "../logger.js";
import { StrangerPasses } from "../stranger/matrix-identity.js";
import { PUBLISH_AFTER_MS } from "./config.js";
import { publishFunnel, type FunnelCounts } from "./funnel.js";
import { liveTerms } from "./card.js";
import { HOST_TERMS_VERSION, hostTerms } from "./terms.js";
import type { HostTools } from "./service.js";
import { CODE_NOT_AVAILABLE, CODES_PAUSED, ShareService } from "./share.js";
import type { HostEvent, HostPerson, PublishedFunnel } from "./types.js";

/** The RI discussion deck (spec §B.6): static, from the studio, no player data. */
export const DECK = {
  title: "talking about raising someone, together",
  intro: "questions for after the game. they come from the studio, not from anyone's game.",
  questions: [
    "what did your child need from you that you didn't expect to have to give?",
    "at 3, a tantrum. what did you reach for first: calm, rules, or distraction? where did you learn that?",
    "when your child first lied, did you want the truth or the reason?",
    "what's a secret a 14-year-old should be allowed to keep?",
    "when you and your co-parent disagreed, what did you want your child to see?",
    "what did you say that you'd want your child to hear in their head at 25?",
    "what's one thing your own parents did that you caught yourself repeating, or refusing?",
    "if your child asked you something with no clean answer, what did you do with the not-knowing?",
    "what does \"fair\" between two parents look like when one of you is tired?",
    "what would you do differently with a second child?",
  ],
} as const;

const NOT_SIGNED_IN = "Not signed in.";
const NEEDS_AGREEMENT = "please read and agree to the host terms first.";

/**
 * The host portal (spec §4, §B.3 /api/host/*): who may sign in, what each
 * sees, and the one publication of the funnel. A host pass holds the HMAC
 * subject only, in memory, like a stranger pass.
 */
export class HostPortal {
  readonly passes: StrangerPasses;
  constructor(private readonly hosts: HostTools, passes?: StrangerPasses) {
    this.passes = passes ?? new StrangerPasses(() => hosts.now());
    // One revocation kills both: a stranger pass revoked (a minor result, a ban) takes the host pass with it.
    hosts.stranger.passes.onRevoke((mxid) => this.passes.revokeSubject(mxid));
  }

  /** Approved, still an adult in good standing, else the same 401 as a bad token. */
  async issuePass(openIdToken: unknown): Promise<{ pass: string } | null> {
    const mxid = await this.hosts.stranger.verifyMatrix(openIdToken);
    if (!mxid) return null;
    const subject = await this.hosts.stranger.age.subjectHash(mxid);
    const person = await this.hosts.store.personBySubject(subject);
    if (!person || person.status !== "approved") return null;
    if (!(await this.eligible(mxid, subject))) return null;
    // The pass holds the Matrix id in memory only (like a stranger pass), so every request can re-run the age and ban check.
    return { pass: this.passes.issue(mxid, null) };
  }

  /** Still a verified adult, not banned, not suspended from stranger mode. Fails closed. */
  private async eligible(mxid: string, subject: string): Promise<boolean> {
    try {
      if (!(await this.hosts.stranger.age.adultForPool(mxid)).ok) return false;
      return !(await this.hosts.stranger.store.isSuspended(subject));
    } catch {
      return false;
    }
  }

  /**
   * The person behind a live pass. Re-checked on every request: still approved
   * by the admin, still an adult, not banned, not suspended. Anything else
   * retires the pass at once.
   */
  async person(pass: unknown): Promise<HostPerson | null> {
    const p = this.passes.resolve(pass);
    if (!p) return null;
    const mxid = p.subject;
    const subject = await this.hosts.stranger.age.subjectHash(mxid);
    const person = await this.hosts.store.personBySubject(subject);
    if (!person || person.status !== "approved" || !(await this.eligible(mxid, subject))) {
      this.passes.revokeSubject(mxid);
      return null;
    }
    return person;
  }

  async counts(e: HostEvent): Promise<FunnelCounts> {
    const runs = (await this.hosts.stranger.store.runsForEvent(e.id)).filter((r) => !r.discarded);
    const handles = (e.frozenTerms ?? liveTerms(e, this.hosts.live())).handleExchange;
    let swapped: number | null = null;
    if (handles) {
      swapped = 0;
      for (const r of runs) if ((await this.hosts.stranger.store.exchangeOutcome(r.gameId)) === "revealed") swapped++;
    }
    return {
      joined: await this.hosts.store.countQueued(e.id),
      started: runs.length,
      finished: runs.filter((r) => r.finishedAt !== null).length,
      swapped,
    };
  }

  /** When the one publication may happen: 24 hours after the event closed. */
  publishableAt(e: HostEvent): number {
    return Math.min(e.closedAt ?? Infinity, e.closesAt) + PUBLISH_AFTER_MS;
  }

  /** Only an outside host at level 1 or above is ever shown numbers (§4.1, §4.3); studio events and level 0 never have a funnel. */
  static hasFunnel(e: HostEvent): boolean {
    return e.kind === "outside" && e.level >= 1;
  }

  /** Publishes once, at least 24 hours after close; never recomputed. Returns what's published (or null). */
  async publishIfDue(e: HostEvent): Promise<PublishedFunnel | null> {
    if (!HostPortal.hasFunnel(e)) return null;
    if (e.publishedFunnel) return e.publishedFunnel;
    if (this.hosts.now() < this.publishableAt(e)) return null;
    const funnel = publishFunnel(await this.counts(e));
    await this.hosts.store.publishFunnel(e.id, funnel, this.hosts.now());
    const saved = await this.hosts.store.getEvent(e.id);
    if (saved) this.hosts.refresh(saved);
    logger.info("host_funnel_published", { eventId: e.id });
    return saved?.publishedFunnel ?? funnel;
  }

  /** What one person sees of the events they host or read for (§4.3). */
  async eventsFor(person: HostPerson): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const e of this.hosts.listCached().sort((a, b) => b.opensAt - a.opensAt)) {
      if (e.source !== "admin") continue;
      if (e.hostPersonId === person.id) {
        const funnelShown = e.level >= 1;
        out.push({
          ref: this.hosts.ref("event", person.id, e.id), role: "host", name: e.name, level: e.level, status: await this.hosts.statusNow(e),
          opensAt: e.opensAt, closesAt: e.closedAt ?? e.closesAt, shareCodes: e.shareCodes,
          ...(funnelShown ? { funnel: await this.publishIfDue(e) } : {}),
        });
      } else if (e.guestReaderId === person.id) {
        out.push({ ref: this.hosts.ref("event", person.id, e.id), role: "guest", name: e.name, opensAt: e.opensAt, closesAt: e.closedAt ?? e.closesAt });
      }
    }
    return out;
  }
}

export function createHostPortalRoutes(hosts: HostTools, portal: HostPortal, limit: RequestHandler, share?: ShareService): Router {
  const router = Router();
  const hide = (next: NextFunction) => next("router");
  router.use(["/host"], (_req: Request, res: Response, next: NextFunction) => {
    if (!hosts.active()) return hide(next);
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // What ?host=1 and ?stranger=account wait on before painting anything: off, a path never built.
  router.get("/host/on", limit, (_req: Request, res: Response) => void res.json({ on: true }));

  router.post("/host/pass", limit, async (req: Request, res: Response) => {
    await hosts.ready;
    const r = await portal.issuePass((req.body as { openIdToken?: unknown } | undefined)?.openIdToken);
    if (!r) return void res.status(401).json({ error: NOT_SIGNED_IN });
    res.json(r);
  });

  // A person the admin added without a signed agreement agrees in the portal first
  // (persona tests, S2-5): until then, only their page and the terms open.
  const withPerson = (fn: (person: HostPerson, req: Request, res: Response) => Promise<void>, opts: { beforeAgreement?: boolean } = {}) =>
    async (req: Request, res: Response) => {
      await hosts.ready;
      const person = await portal.person((req.body as { pass?: unknown } | undefined)?.pass);
      if (!person) return void res.status(401).json({ error: NOT_SIGNED_IN });
      if (person.agreementAt === null && !opts.beforeAgreement) return void res.status(403).json({ error: NEEDS_AGREEMENT });
      await fn(person, req, res);
    };

  router.post("/host/events", limit, withPerson(async (person, _req, res) => {
    if (person.agreementAt === null) {
      return void res.json({ displayName: person.displayName, needsAgreement: true, terms: hostTerms(person.hostType), events: [] });
    }
    res.json({ displayName: person.displayName, events: await portal.eventsFor(person) });
  }, { beforeAgreement: true }));

  router.post("/host/agree", limit, withPerson(async (person, req, res) => {
    if ((req.body as { version?: unknown }).version !== HOST_TERMS_VERSION) {
      return void res.status(409).json({ error: "the terms changed. here are the current ones.", terms: hostTerms(person.hostType) });
    }
    if (person.agreementAt === null) await hosts.agree(person, HOST_TERMS_VERSION);
    res.json({ ok: true });
  }, { beforeAgreement: true }));

  // Share codes (§5.2). Every failure: the same 404, the same body, after the same floor. Past 10
  // failures an hour (30 a day) every new code, right or wrong, gets the same 429 after the same
  // floor; a code this reader already opened still re-opens, uncounted.
  router.post("/host/codes/redeem", limit, async (req: Request, res: Response) => {
    const started = Date.now();
    let codeRef: string | "paused" | "unagreed" | null = null;
    let signedIn = true;
    try {
      await hosts.ready;
      const body = (req.body ?? {}) as { pass?: unknown; words?: unknown };
      const person = await portal.person(body.pass);
      signedIn = !!person;
      if (person && person.agreementAt === null) codeRef = "unagreed";
      else if (person && share) codeRef = await share.redeem(person, body.words);
    } catch {
      codeRef = null;
    }
    await ShareService.floor(started);
    // Not signed in says nothing about any code; it only sends the host back to sign-in.
    if (!signedIn) return void res.status(401).json({ error: NOT_SIGNED_IN });
    if (codeRef === "unagreed") return void res.status(403).json({ error: NEEDS_AGREEMENT });
    if (codeRef === "paused") return void res.status(429).json({ error: CODES_PAUSED });
    if (!codeRef) return void res.status(404).json({ error: CODE_NOT_AVAILABLE });
    res.json({ codeRef });
  });

  // The codes this reader opened, while she can still read them: she never re-types them (S2-1).
  router.post("/host/codes/list", limit, withPerson(async (person, _req, res) => {
    res.json({ codes: share ? await share.openedCodes(person) : [] });
  }));

  router.post("/host/codes/view", limit, withPerson(async (person, req, res) => {
    const v = share ? await share.viewCode(person, (req.body as { codeRef?: unknown } | undefined)?.codeRef) : null;
    if (!v) return void res.status(404).json({ error: CODE_NOT_AVAILABLE });
    res.json({ snapshot: v.snapshot, until: v.until, watermark: { reader: v.reader, openedAt: v.openedAt } });
  }));

  // The host's own meetup (persona tests, Kofi): the link to hand out, the card
  // players are shown, and a new link. The event's host only, never a guest
  // reader or a promoter.
  const hostEvent = (person: HostPerson, ref: string) =>
    hosts.listCached().find((x) => x.source === "admin" && x.hostPersonId === person.id && hosts.ref("event", person.id, x.id) === ref) ?? null;

  router.post("/host/events/:ref/link", limit, withPerson(async (person, req, res) => {
    const e = hostEvent(person, String(req.params.ref));
    if (!e) return void res.status(404).json({ error: "Not found" });
    if (hosts.status(e) === "closed") return void res.status(409).json({ error: "this meetup is closed." });
    res.json(hosts.codeFor(e) ?? { link: null, code: null });
  }));

  router.post("/host/events/:ref/card", limit, withPerson(async (person, req, res) => {
    const e = hostEvent(person, String(req.params.ref));
    if (!e) return void res.status(404).json({ error: "Not found" });
    res.json({ card: await hosts.cardFor(e) });
  }));

  router.post("/host/events/:ref/new-link", limit, withPerson(async (person, req, res) => {
    const e = hostEvent(person, String(req.params.ref));
    if (!e) return void res.status(404).json({ error: "Not found" });
    const r = await hosts.newCode(e.id);
    if (!r.ok) return void res.status(r.status).json({ error: r.error });
    res.json(r.value);
  }));

  // Pause, close, lower: the host of that event only (never a guest reader), at any time.
  for (const action of ["pause", "resume", "close", "lower"] as const) {
    router.post(`/host/events/:ref/${action}`, limit, withPerson(async (person, req, res) => {
      const ref = String(req.params.ref);
      const e = hosts.listCached().find((x) => x.hostPersonId === person.id && hosts.ref("event", person.id, x.id) === ref);
      if (!e) return void res.status(404).json({ error: "Not found" });
      const patch = action === "pause" ? { paused: true } : action === "resume" ? { paused: false } : action === "close" ? { closed: true }
        : { level: e.level === 3 ? 1 : 0 };
      if (action === "lower" && e.level === 0) return void res.status(409).json({ error: "this meetup is already at the lowest level." });
      const r = await hosts.patchEvent(e.id, patch, "host");
      if (!r.ok) return void res.status(r.status).json({ error: r.error });
      res.json({ ok: true, status: await hosts.statusNow(r.value), level: r.value.level });
    }));
  }

  return router;
}

export function createHostPortalAdminRoutes(hosts: HostTools, portal: HostPortal): Router {
  const router = Router();
  router.post("/admin/host-tools/events/:id/publish", requireAdmin, async (req: Request, res: Response) => {
    await hosts.ready;
    const e = hosts.eventById(String(req.params.id));
    if (!e) return void res.status(404).json({ error: "No such event" });
    if (!HostPortal.hasFunnel(e)) return void res.status(409).json({ error: "this meetup has no published numbers (studio events and level 0 never do)" });
    if (e.publishedFunnel) return void res.status(409).json({ error: "already published", funnel: e.publishedFunnel });
    const f = await portal.publishIfDue(e);
    if (!f) return void res.status(409).json({ error: "the funnel publishes 24 hours after the event closes", publishableAt: portal.publishableAt(e) });
    res.json({ funnel: f });
  });
  return router;
}

/**
 * The deck (§B.6), in every mode (persona tests, finding 10): a link on a
 * class handout has to work whenever the site is up. Static, no player data,
 * no sign-in, nothing logged.
 */
export function createDeckRoute(limit: RequestHandler): Router {
  const router = Router();
  router.get("/events/deck", limit, (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ deck: DECK });
  });
  return router;
}
