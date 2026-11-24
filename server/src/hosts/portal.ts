import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { requireAdmin } from "../routes/admin.js";
import { logger } from "../logger.js";
import { StrangerPasses } from "../stranger/matrix-identity.js";
import { PUBLISH_AFTER_MS } from "./config.js";
import { publishFunnel, type FunnelCounts } from "./funnel.js";
import { liveTerms } from "./card.js";
import type { HostTools } from "./service.js";
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

/**
 * The host portal (spec §4, §B.3 /api/host/*): who may sign in, what each
 * sees, and the one publication of the funnel. A host pass holds the HMAC
 * subject only, in memory, like a stranger pass.
 */
export class HostPortal {
  readonly passes: StrangerPasses;
  constructor(private readonly hosts: HostTools, passes?: StrangerPasses) {
    this.passes = passes ?? new StrangerPasses(() => hosts.now());
  }

  /** Approved, still an adult in good standing, else the same 401 as a bad token. */
  async issuePass(openIdToken: unknown): Promise<{ pass: string } | null> {
    const mxid = await this.hosts.stranger.verifyMatrix(openIdToken);
    if (!mxid) return null;
    const subject = await this.hosts.stranger.age.subjectHash(mxid);
    const person = await this.hosts.store.personBySubject(subject);
    if (!person || person.status !== "approved") return null;
    if (!(await this.hosts.stranger.age.adultForPool(mxid)).ok) return null;
    return { pass: this.passes.issue(subject, null) };
  }

  /** The person behind a live pass, if still approved. */
  async person(pass: unknown): Promise<HostPerson | null> {
    const p = this.passes.resolve(pass);
    if (!p) return null;
    const person = await this.hosts.store.personBySubject(p.subject);
    if (!person || person.status !== "approved") {
      this.passes.revokeSubject(p.subject);
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

  /** Publishes once, at least 24 hours after close; never recomputed. Returns what's published (or null). */
  async publishIfDue(e: HostEvent): Promise<PublishedFunnel | null> {
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

export function createHostPortalRoutes(hosts: HostTools, portal: HostPortal, limit: RequestHandler): Router {
  const router = Router();
  const hide = (next: NextFunction) => next("router");
  router.use(["/host", "/events/deck"], (_req: Request, res: Response, next: NextFunction) => {
    if (!hosts.active()) return hide(next);
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/events/deck", limit, (_req: Request, res: Response) => void res.json({ deck: DECK }));

  router.post("/host/pass", limit, async (req: Request, res: Response) => {
    await hosts.ready;
    const r = await portal.issuePass((req.body as { openIdToken?: unknown } | undefined)?.openIdToken);
    if (!r) return void res.status(401).json({ error: NOT_SIGNED_IN });
    res.json(r);
  });

  const withPerson = (fn: (person: HostPerson, req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      await hosts.ready;
      const person = await portal.person((req.body as { pass?: unknown } | undefined)?.pass);
      if (!person) return void res.status(401).json({ error: NOT_SIGNED_IN });
      await fn(person, req, res);
    };

  router.post("/host/events", limit, withPerson(async (person, _req, res) => {
    res.json({ displayName: person.displayName, events: await portal.eventsFor(person) });
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
      const r = await hosts.patchEvent(e.id, patch);
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
    if (e.publishedFunnel) return void res.status(409).json({ error: "already published", funnel: e.publishedFunnel });
    const f = await portal.publishIfDue(e);
    if (!f) return void res.status(409).json({ error: "the funnel publishes 24 hours after the event closes", publishableAt: portal.publishableAt(e) });
    res.json({ funnel: f });
  });
  return router;
}
