import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { StrangerPasses } from "../stranger/matrix-identity.js";
import type { EventRun } from "../stranger/store.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { ShareService } from "./share.js";
import type { HostTools } from "./service.js";
import type { HostEvent, Slot } from "./types.js";
import { HostPortal } from "./portal.js";
import { CODE_ACCESS_MS } from "./config.js";
import type { LearningService } from "./learning.js";
import type { UnlinkService } from "./unlink.js";

const NOT_SIGNED_IN = "Not signed in.";
const NOT_FOUND = "Not found";

/**
 * One game's share state, as its own seat may know it. "code": until is the
 * latest moment anyone can read it (before it's opened: the open-by date plus
 * the read window that follows); openBy is there only while unopened.
 * "stopped": this seat stopped it. "ended": the co-parent stopped it, or it
 * lapsed by the clock; the row never says which. Safety state is never read
 * into a row (no oracle for a report or ban).
 */
type ShareRow =
  | { state: "waiting" }
  | { state: "later"; until: number }
  | { state: "no"; until: number }
  | { state: "code"; words: string; host: string; until: number; openBy?: number; opened: number[] }
  | { state: "stopped"; at: number }
  | { state: "ended" }
  | { state: "none" };

/**
 * What the host side saw of a meetup (spec §4.1, §4.3), exactly as each
 * role sees it. A studio event never has a funnel, with or without a guest
 * reader; an outside level-0 host sees only whether it's open.
 */
type HostPanel =
  | { kind: "nothing"; who: "nobody" }
  | { kind: "nothing"; who: "guest"; reader: string }
  | { kind: "status"; host: string }
  | { kind: "pending"; host: string }
  | { kind: "funnel"; host: string; funnel: unknown };

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
    private readonly learning: LearningService,
    private readonly unlink: UnlinkService,
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

  /** The Matrix id behind a live account pass (memory only, never stored). */
  mxidOf(pass: unknown): string | null {
    return this.passes.resolve(pass)?.subject ?? null;
  }

  /**
   * "take this game off my account": the request (the code stops now), and
   * the game leaves this account's kid list now, while the Matrix id is in
   * hand; the user routes won't let it be synced back.
   */
  async requestUnlink(subject: string, mxid: string | null, seat: { run: EventRun; slot: Slot; event: HostEvent }): Promise<void> {
    await this.unlink.request(subject, seat);
    if (mxid) await this.repo.deleteUserGame(mxid, seat.run.gameId);
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
      // A player's explicit stop shows on both rows (the stopper's says so; the co-parent's says only that
      // it no longer opens). A stop the server made for a safety reason (stoppedBy null) never shows here:
      // this page is loaded by the player, so it must never act as an oracle for a report, case, ban,
      // block or suspension. That stop surfaces only as the reader's generic "isn't available".
      if (code.stoppedAt !== null && code.stoppedBy !== null) return code.stoppedBy === slot ? { state: "stopped", at: code.stoppedAt } : { state: "ended" };
      const words = this.share.words(code);
      if (!words) return { state: "none" };
      const opened = code.redeemedBy !== null;
      // Unopened, it can be opened until expiresAt and then read for CODE_ACCESS_MS: the latest date anyone could read it.
      const until = opened ? (code.accessUntil ?? code.expiresAt) : code.expiresAt + CODE_ACCESS_MS;
      // Lapsing is by the clock alone, the same schedule for every code: no safety state is read here.
      if (opened ? until <= now : now >= code.expiresAt) return { state: "ended" };
      const log = await this.hosts.store.accessLog(code.id);
      return { state: "code", words, host: await this.hostName(event), until, ...(opened ? {} : { openBy: code.expiresAt }), opened: log };
    }
    if (code) return { state: "waiting" };
    const windowEnd = this.share.windowEnd(run);
    if (now >= windowEnd) return { state: "none" };
    const mine = (await this.hosts.store.getDecisions(run.gameId)).find((d) => d.slot === slot);
    if (mine?.answer === "yes") return { state: "waiting" };
    if (mine?.answer === "no") return { state: "no", until: windowEnd };
    return { state: "later", until: windowEnd };
  }

  private async childName(gameId: string): Promise<string> {
    const s = this.games.get(gameId) ?? (await this.repo.loadGame(gameId).catch(() => null));
    return s?.childName ?? "";
  }

  /**
   * What the host side saw of this event, as that role sees it (§4.1, §4.3).
   * Only an outside level-1+ host is ever shown numbers, and only then is a
   * funnel published from here; a studio event never gets one.
   */
  private async panel(event: HostEvent): Promise<HostPanel> {
    const person = await this.share.readerOf(event);
    if (event.kind === "studio") return person ? { kind: "nothing", who: "guest", reader: person.displayName } : { kind: "nothing", who: "nobody" };
    const host = person?.displayName ?? "your host";
    if (!HostPortal.hasFunnel(event)) return { kind: "status", host };
    const f = await this.portal.publishIfDue(event);
    return f ? { kind: "funnel", host, funnel: f } : { kind: "pending", host };
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
        // When it finished, so rows at the same meetup can be told apart.
        finishedAt: run.finishedAt,
        share: await this.shareRow(run, slot, event),
        // Studio learning: this seat's own answer only (null: not offered here).
        learning: await this.learning.own(run.gameId, slot),
        // "take this game off my account": asked, waiting for the studio.
        unlink: (await this.unlink.pending(subject, run.gameId)) ? "requested" : null,
      });
    }
    return { meetups, games, hostSaw: [...panels.values()] };
  }

  async forgetMeetup(subject: string, eventRef: unknown): Promise<boolean> {
    if (typeof eventRef !== "string") return false;
    for (const a of await this.hosts.store.acksForSubject(subject)) {
      if (this.hosts.ref("event", subject, a.eventId) === eventRef) {
        // Deleted, not hidden: nothing needs it once the player lets it go. The
        // event's terms are frozen on the event, reports go through the game's
        // run, and the funnel counts only who queued (a published funnel is
        // kept as published).
        await this.hosts.store.deleteAcks(subject, a.eventId);
        return true;
      }
    }
    return false;
  }
}

export function createAccountRoutes(hosts: HostTools, account: AccountService, share: ShareService, unlink: UnlinkService, learning: LearningService, limit: RequestHandler): Router {
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

  // "take this game off my account" (spec §6): the code is voided now; the studio does the rest.
  router.post("/stranger/account/unlink", limit, withSubject(async (subject, b, res) => {
    const seat = await account.seatFor(subject, b.gameRef);
    if (!seat) return void res.status(404).json({ error: NOT_FOUND });
    await account.requestUnlink(subject, account.mxidOf(b.pass), seat);
    res.json({ ok: true });
  }));

  // Studio learning: a seat can take back its yes (or say no late) at any time.
  // Withdrawing only: a yes is given at the end of the game, where it was asked.
  router.post("/stranger/account/learning", limit, withSubject(async (subject, b, res) => {
    if (b.answer !== "no") return void res.status(400).json({ error: "only \"no\" can be chosen here." });
    const seat = await account.seatFor(subject, b.gameRef);
    if (!seat || !(await learning.withdraw(seat.run.gameId, seat.slot))) return void res.status(404).json({ error: NOT_FOUND });
    res.json({ learning: "no" });
  }));

  router.post("/stranger/share/preview", limit, withSubject(async (subject, b, res) => {
    const seat = await account.seatFor(subject, b.gameRef);
    if (!seat || !seat.event.shareCodes) return void res.status(404).json({ error: NOT_FOUND });
    res.json({ preview: await share.snapshot(seat.run.gameId) });
  }));

  return router;
}
