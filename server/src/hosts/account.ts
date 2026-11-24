import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { StrangerPasses } from "../stranger/matrix-identity.js";
import type { EventRun } from "../stranger/store.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { ShareService } from "./share.js";
import type { HostTools } from "./service.js";
import type { HostEvent, Slot } from "./types.js";
import type { HostPortal } from "./portal.js";

const NOT_SIGNED_IN = "Not signed in.";
const NOT_FOUND = "Not found";

type ShareRow =
  | { state: "waiting" }
  | { state: "later"; until: number }
  | { state: "code"; words: string; host: string; until: number; opened: number[] }
  | { state: "stopped"; at: number }
  | { state: "none" };

/**
 * The stranger player's account page (spec §5.4): their own rows only,
 * behind an account pass that is re-checked on every request.
 */
export class AccountService {
  readonly passes: StrangerPasses;

  constructor(
    private readonly hosts: HostTools,
    private readonly share: ShareService,
    private readonly portal: HostPortal,
    private readonly games: Map<string, GameState>,
    private readonly repo: GameRepository,
  ) {
    this.passes = new StrangerPasses(() => hosts.now());
    hosts.stranger.passes.onRevoke((mxid) => this.passes.revokeSubject(mxid));
  }

  private async eligible(mxid: string): Promise<boolean> {
    try {
      return (await this.hosts.stranger.age.adultForPool(mxid)).ok;
    } catch {
      return false;
    }
  }

  async issuePass(openIdToken: unknown): Promise<{ pass: string } | null> {
    const mxid = await this.hosts.stranger.verifyMatrix(openIdToken);
    if (!mxid || !(await this.eligible(mxid))) return null;
    return { pass: this.passes.issue(mxid, null) };
  }

  /** The subject behind a live account pass, re-checked every time (a minor result or a ban ends it at once). */
  async subject(pass: unknown): Promise<string | null> {
    const p = this.passes.resolve(pass);
    if (!p) return null;
    if (!(await this.eligible(p.subject))) {
      this.passes.revokeSubject(p.subject);
      return null;
    }
    return this.hosts.stranger.age.subjectHash(p.subject);
  }

  private slotOf(run: EventRun, subject: string): Slot | null {
    return run.parent1 === subject ? "parent1" : run.parent2 === subject ? "parent2" : null;
  }

  /** This subject's runs at host-tools events, with their seat. */
  private async seats(subject: string): Promise<Array<{ run: EventRun; slot: Slot; event: HostEvent }>> {
    const out: Array<{ run: EventRun; slot: Slot; event: HostEvent }> = [];
    for (const run of await this.hosts.stranger.store.runsForSubject(subject)) {
      if (run.discarded || !run.eventId) continue;
      const slot = this.slotOf(run, subject);
      const event = this.hosts.eventById(run.eventId) ?? (await this.hosts.store.getEvent(run.eventId));
      if (slot && event) out.push({ run, slot, event });
    }
    return out;
  }

  /** The seat behind an opaque game ref, if it is this subject's. */
  async seatFor(subject: string, gameRef: unknown): Promise<{ run: EventRun; slot: Slot; event: HostEvent } | null> {
    if (typeof gameRef !== "string" || !gameRef) return null;
    return (await this.seats(subject)).find((s) => this.hosts.ref("game", subject, s.run.gameId) === gameRef) ?? null;
  }

  private async hostName(event: HostEvent): Promise<string> {
    return (await this.share.readerOf(event))?.displayName ?? (event.kind === "studio" ? "the studio" : "your host");
  }

  async shareRow(run: EventRun, slot: Slot, event: HostEvent): Promise<ShareRow | null> {
    if (!event.shareCodes || run.finishedAt === null) return null;
    const now = this.hosts.now();
    const code = await this.hosts.store.codeByGame(run.gameId);
    if (code && now >= code.visibleAt) {
      if (code.stoppedAt !== null && code.stoppedBy === slot) return { state: "stopped", at: code.stoppedAt };
      const words = this.share.words(code);
      if (!words) return { state: "none" };
      const opened = (await this.hosts.store.accessLog(code.id)).filter((t) => code.stoppedAt === null || t <= code.stoppedAt);
      return { state: "code", words, host: await this.hostName(event), until: code.redeemedBy ? (code.accessUntil ?? code.expiresAt) : code.expiresAt, opened };
    }
    if (code) return { state: "waiting" };
    const windowEnd = this.share.windowEnd(run);
    if (now >= windowEnd) return { state: "none" };
    const mine = (await this.hosts.store.getDecisions(run.gameId)).find((d) => d.slot === slot);
    if (mine?.answer === "yes") return { state: "waiting" };
    if (mine?.answer === "no") return { state: "none" };
    return { state: "later", until: windowEnd };
  }

  private async childName(gameId: string): Promise<string> {
    const s = this.games.get(gameId) ?? (await this.repo.loadGame(gameId).catch(() => null));
    return s?.childName ?? "";
  }

  /** What the host saw of this event: the published panel, or why there isn't one. */
  private async panel(event: HostEvent): Promise<unknown> {
    if (event.level === 0) return { kind: "nothing" };
    const f = await this.portal.publishIfDue(event);
    if (!f) return { kind: "pending" };
    return { kind: "funnel", funnel: f };
  }

  async page(subject: string): Promise<unknown> {
    const meetups: unknown[] = [];
    const seen = new Set<string>();
    const acks = (await this.hosts.store.acksForSubject(subject)).filter((a) => a.unlistedAt === null).sort((a, b) => b.at - a.at);
    for (const a of acks) {
      if (seen.has(a.eventId)) continue;
      seen.add(a.eventId);
      const event = this.hosts.eventById(a.eventId) ?? (await this.hosts.store.getEvent(a.eventId));
      if (!event) continue;
      meetups.push({
        ref: this.hosts.ref("event", subject, event.id), name: event.name, at: a.at,
        card: await this.hosts.store.getCard(event.id, a.cardVersion),
      });
    }
    const games: unknown[] = [];
    const panels = new Map<string, unknown>();
    for (const { run, slot, event } of await this.seats(subject)) {
      if (!panels.has(event.id)) panels.set(event.id, { name: event.name, panel: await this.panel(event) });
      games.push({
        ref: this.hosts.ref("game", subject, run.gameId), childName: await this.childName(run.gameId), eventName: event.name,
        share: await this.shareRow(run, slot, event),
      });
    }
    return { meetups, games, hostSaw: [...panels.values()] };
  }

  async forgetMeetup(subject: string, eventRef: unknown): Promise<boolean> {
    if (typeof eventRef !== "string") return false;
    for (const a of await this.hosts.store.acksForSubject(subject)) {
      if (this.hosts.ref("event", subject, a.eventId) === eventRef) {
        await this.hosts.store.unlistAcks(subject, a.eventId, this.hosts.now());
        return true;
      }
    }
    return false;
  }
}

export function createAccountRoutes(hosts: HostTools, account: AccountService, share: ShareService, limit: RequestHandler): Router {
  const router = Router();
  router.use(["/stranger/account", "/stranger/share"], (_req: Request, res: Response, next: NextFunction) => {
    if (!hosts.active()) return next("router");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/stranger/account/pass", limit, async (req: Request, res: Response) => {
    await hosts.ready;
    const r = await account.issuePass((req.body as { openIdToken?: unknown } | undefined)?.openIdToken);
    if (!r) return void res.status(401).json({ error: NOT_SIGNED_IN });
    res.json(r);
  });

  const withSubject = (fn: (subject: string, body: Record<string, unknown>, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      await hosts.ready;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const subject = await account.subject(body.pass);
      if (!subject) return void res.status(401).json({ error: NOT_SIGNED_IN });
      await fn(subject, body, res);
    };

  router.post("/stranger/account", limit, withSubject(async (subject, _b, res) => {
    res.json(await account.page(subject));
  }));

  router.post("/stranger/account/decide", limit, withSubject(async (subject, b, res) => {
    const seat = await account.seatFor(subject, b.gameRef);
    if (!seat) return void res.status(404).json({ error: NOT_FOUND });
    const view = await share.answer(seat.run.gameId, seat.slot, b.answer);
    if (!view) return void res.status(409).json({ error: "this can't be decided any more." });
    res.json({ share: await account.shareRow({ ...seat.run }, seat.slot, seat.event) });
  }));

  router.post("/stranger/account/stop", limit, withSubject(async (subject, b, res) => {
    const seat = await account.seatFor(subject, b.gameRef);
    if (!seat || !(await share.stop(seat.run.gameId, seat.slot))) return void res.status(404).json({ error: NOT_FOUND });
    res.json({ share: await account.shareRow(seat.run, seat.slot, seat.event) });
  }));

  router.post("/stranger/account/forget-meetup", limit, withSubject(async (subject, b, res) => {
    if (!(await account.forgetMeetup(subject, b.eventRef))) return void res.status(404).json({ error: NOT_FOUND });
    res.json({ ok: true });
  }));

  router.post("/stranger/share/preview", limit, withSubject(async (subject, b, res) => {
    const seat = await account.seatFor(subject, b.gameRef);
    if (!seat || !seat.event.shareCodes) return void res.status(404).json({ error: NOT_FOUND });
    res.json({ preview: await share.snapshot(seat.run.gameId) });
  }));

  return router;
}
