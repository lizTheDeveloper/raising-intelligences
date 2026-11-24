import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { isGameHeldInProcess } from "../observability/child-safety-exclusion.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import type { EventRun } from "../stranger/store.js";
import {
  CODE_ACCESS_MS, CODE_REDEEM_MS, REDEEM_FLOOR_MS, REDEEM_PER_DAY, REDEEM_PER_HOUR, REVEAL_MAX_MS, REVEAL_MIN_MS, SHARE_WINDOW_MS,
} from "./config.js";
import { deriveShareWords, normalizeWords } from "./codes.js";
import { buildShareSnapshot, snapshotEmpty } from "./share-snapshot.js";
import type { HostTools } from "./service.js";
import type { HostEvent, HostPerson, ShareCodeRow, ShareSnapshot, Slot } from "./types.js";

export type ShareAnswer = "yes" | "no" | "later";

/** What one seat sees after answering (spec §5.1 step 5). Never anything about the other seat. */
export type ShareView =
  | { state: "ask" }
  | { state: "waiting" }
  | { state: "no"; until: number }
  | { state: "later"; until: number };

/** Every failure of a redemption, whatever the reason (§5.2). */
export const CODE_NOT_AVAILABLE = "this code isn't available.";
/** Too many codes that didn't open lately: the same answer for every code, right or wrong. */
export const CODES_PAUSED = "too many codes didn't open lately, so new codes are paused: try again in an hour (or tomorrow, after 30 in a day). codes you've already opened still open from your list.";

export interface ShareDeps {
  hosts: HostTools;
  repo: GameRepository;
  games: Map<string, GameState>;
  /** The players' display names, by slot (replaced by "Parent 1/2" in the snapshot, H5). */
  names?: (gameId: string) => Partial<Record<Slot, string>>;
  random?: () => number;
}

/**
 * Share codes (spec §5): the share step after the report card, the code made
 * at the second yes, the account page, and the host's redemption and view.
 * Every finished game at a share-code event gets the same step, the same
 * answers and the same random delay; an excluded game simply never gets a
 * code (B1, B3, H25).
 */
export class ShareService {
  private readonly rng: () => number;
  private failures = new Map<string, number[]>();
  /** The delay drawn at each second yes (tests read it: same distribution for every game). */
  readonly drawn: Array<{ gameId: string; delayMs: number }> = [];

  constructor(private readonly deps: ShareDeps) {
    this.rng = deps.random ?? Math.random;
  }

  private get hosts(): HostTools { return this.deps.hosts; }
  private now(): number { return this.hosts.now(); }

  /** The run and its event, for a finished stranger game at an event with share codes. */
  async context(gameId: string): Promise<{ run: EventRun; event: HostEvent } | null> {
    const seats = await this.hosts.stranger.matching?.runFor(gameId);
    if (!seats?.eventId || seats.discarded) return null;
    const event = this.hosts.eventById(seats.eventId) ?? (await this.hosts.store.getEvent(seats.eventId));
    if (!event?.shareCodes) return null;
    const run = (await this.hosts.stranger.store.runsForEvent(event.id)).find((r) => r.gameId === gameId);
    if (!run || run.discarded || run.finishedAt === null) return null;
    return { run, event };
  }

  windowEnd(run: EventRun): number {
    return (run.finishedAt ?? 0) + SHARE_WINDOW_MS;
  }

  private view(answer: ShareAnswer | null, windowEndsAt: number): ShareView {
    if (answer === "yes") return { state: "waiting" };
    if (answer === "no") return { state: "no", until: windowEndsAt };
    if (answer === "later") return { state: "later", until: windowEndsAt };
    return { state: "ask" };
  }

  /** This seat's own answer so far (a reload of the end screen). */
  async status(gameId: string, slot: Slot): Promise<ShareView | null> {
    const ctx = await this.context(gameId);
    if (!ctx) return null;
    const code = await this.hosts.store.codeByGame(gameId);
    if (code) return { state: "waiting" }; // both said yes: the decision rows are gone
    const d = (await this.hosts.store.getDecisions(gameId)).find((x) => x.slot === slot);
    return this.view(d?.answer ?? null, this.windowEnd(ctx.run));
  }

  /**
   * One seat answers. yes is final. "later" can become yes or no, and no can
   * become yes, until the window closes: a no turned yes looks to the other
   * seat exactly like a "later" turned yes (the same random delay before a
   * code, and no message either way). The reply is only this seat's own view,
   * and nothing is ever sent to the other seat because of it.
   */
  async answer(gameId: string, slot: Slot, answer: unknown): Promise<ShareView | null> {
    if (answer !== "yes" && answer !== "no" && answer !== "later") return null;
    const ctx = await this.context(gameId);
    if (!ctx) return null;
    const windowEndsAt = this.windowEnd(ctx.run);
    if (this.now() >= windowEndsAt) return null;
    if (await this.hosts.store.codeByGame(gameId)) return { state: "waiting" };
    const prior = (await this.hosts.store.getDecisions(gameId)).find((x) => x.slot === slot);
    if (prior?.answer === "yes") return this.view("yes", windowEndsAt);
    if (prior?.answer === "no" && answer !== "yes") return this.view("no", windowEndsAt);
    await this.hosts.store.setDecision({ gameId, slot, answer, at: this.now(), windowEndsAt });
    const all = await this.hosts.store.getDecisions(gameId);
    if (answer === "yes" && all.length === 2 && all.every((d) => d.answer === "yes")) await this.secondYes(gameId, ctx);
    return this.view(answer, windowEndsAt);
  }

  /**
   * Both said yes. The delay is drawn first, for every game, so an excluded
   * game is indistinguishable in timing; only then is the game checked, and a
   * code made (or not).
   */
  private async secondYes(gameId: string, ctx: { run: EventRun; event: HostEvent }): Promise<void> {
    const delayMs = Math.round(REVEAL_MIN_MS + this.rng() * (REVEAL_MAX_MS - REVEAL_MIN_MS)); // whole ms: BIGINT columns
    this.drawn.push({ gameId, delayMs });
    const secret = this.hosts.config().shareCodeSecret;
    if (!secret) return;
    if (await this.excluded(gameId, ctx.run)) return;
    const snapshot = await this.snapshot(gameId);
    if (!snapshot || snapshotEmpty(snapshot)) return;
    const id = randomUUID();
    const visibleAt = this.now() + delayMs;
    const row: ShareCodeRow = {
      id, gameId, eventId: ctx.event.id, codeHash: this.hosts.shareHash(deriveShareWords(secret, id)),
      snapshot, visibleAt, expiresAt: visibleAt + CODE_REDEEM_MS,
      redeemedBy: null, redeemedAt: null, accessUntil: null, stoppedAt: null, stoppedBy: null,
    };
    if (await this.hosts.store.insertCode(row)) {
      await this.hosts.store.deleteDecisions(gameId);
      logger.info("share_code_made", { eventId: ctx.event.id });
    }
  }

  private async state(gameId: string): Promise<GameState | null> {
    return this.deps.games.get(gameId) ?? (await this.deps.repo.loadGame(gameId).catch(() => null));
  }

  /**
   * B1 / H1 / H2 / H15: a game that can never make a code. Safety acted on it,
   * a case or hold names it, it was reported, or either seat is no longer an
   * adult in good standing. Fails closed: anything unknown excludes.
   */
  async excluded(gameId: string, run: EventRun): Promise<boolean> {
    try {
      const state = await this.state(gameId);
      if (!state) return true;
      if (state.highestRungFired > 0 || state.cpsOutcome !== null || (state.therapyMessages?.length ?? 0) > 0) return true;
      if (isGameHeldInProcess(gameId)) return true;
      if (await this.deps.repo.childSafety.hasCaseForGame(gameId)) return true;
      const stranger = this.hosts.stranger;
      if (await stranger.gameStopped(gameId)) return true;
      if (await stranger.store.isBlocked(run.parent1, run.parent2)) return true;
      for (const slot of ["parent1", "parent2"] as const) {
        if (!(await this.seatStillAdult(gameId, slot, run[slot]))) return true;
      }
      return false;
    } catch (err) {
      logger.error("share_exclusion_check_failed", { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  }

  /** The adult check on a seat's subject; the ban list needs the Matrix id, known only while its holder is seated in this process. */
  private async seatStillAdult(gameId: string, slot: Slot, subject: string): Promise<boolean> {
    const stranger = this.hosts.stranger;
    if (await stranger.store.isSuspended(subject)) return false;
    // The subject-level check always runs: it covers the ban list even when no
    // Matrix id is in memory (after a restart), and fails closed.
    if (!(await stranger.age.adultBySubject(subject))) return false;
    const mxid = stranger.seatHolder(gameId, slot);
    if (!mxid) return true;
    if ((await stranger.age.subjectHash(mxid)) !== subject) return false;
    return (await stranger.age.adultForPool(mxid)).ok;
  }

  /** §5.3 for this game: the stored report card and epilogue, scrubbed against everything typed, said in private, or noted about the child. */
  async snapshot(gameId: string): Promise<ShareSnapshot | null> {
    const state = await this.state(gameId);
    const endgame = await this.deps.repo.loadEndgame(gameId);
    if (!state || !endgame) return null;
    const typed: string[] = [];
    const privateTalk: string[] = [];
    const childLines: string[] = [];
    for (const m of state.messages ?? []) {
      const parent = m.sender === "parent1" || m.sender === "parent2";
      if (parent) typed.push(m.content);
      // Private talk is everything said outside the shared scene, by either side.
      if (m.chatType !== "shared") privateTalk.push(m.content);
      else if (!parent) childLines.push(m.content);
    }
    for (const p of [state.parentPersonalities?.parent1, state.parentPersonalities?.parent2]) {
      if (p) { typed.push(p.confessional1, p.confessional2); privateTalk.push(p.confessional1, p.confessional2); }
    }
    for (const t of state.therapyMessages ?? []) if (t.speaker === "parent") typed.push(t.content);
    const derived = [state.identityDocument ?? "", state.memorySummary ?? "", ...(state.identitySnapshots ?? []).map((s) => s.document)];
    const scenes: string[] = [];
    for (const e of [...(state.events ?? []), ...(state.currentEvent ? [state.currentEvent] : [])]) scenes.push(e.description, e.setting, e.trigger);
    // H5: both players' names are replaced. Without both names, no snapshot (fail closed).
    const names: Partial<Record<Slot, string>> = { ...(this.deps.names?.(gameId) ?? {}) };
    for (const p of await this.deps.repo.loadPlayers(gameId).catch(() => [])) {
      if ((p.slot === "parent1" || p.slot === "parent2") && !names[p.slot] && p.displayName) names[p.slot] = p.displayName;
    }
    if (!names.parent1?.trim() || !names.parent2?.trim()) return null;
    const pairs: Array<[string, string]> = [[names.parent1, "Parent 1"], [names.parent2, "Parent 2"]];
    return buildShareSnapshot(endgame.reportCard || null, endgame.epilogue || state.epilogue || null, {
      typed, privateTalk, derived, childName: state.childName ?? "", scenes, childLines, players: pairs,
    });
  }

  /**
   * A code keeps working only while its game could still make one: a case,
   * report, block, suspension or failed adult check found later stops it
   * (silently, like a player's stop).
   */
  private async stillShareable(code: ShareCodeRow): Promise<boolean> {
    const run = (await this.hosts.stranger.store.runsForEvent(code.eventId)).find((r) => r.gameId === code.gameId);
    if (!run || run.discarded || (await this.excluded(code.gameId, run))) {
      await this.hosts.store.updateCode(code.id, { stoppedAt: this.now(), stoppedBy: null });
      return false;
    }
    return true;
  }

  /** A seat stops its game's code. Silent: nothing changes for the co-parent but the access log. */
  async stop(gameId: string, slot: Slot): Promise<boolean> {
    const code = await this.hosts.store.codeByGame(gameId);
    if (!code) return false;
    if (code.stoppedBy === null) await this.hosts.store.updateCode(code.id, { stoppedAt: code.stoppedAt ?? this.now(), stoppedBy: slot });
    return true;
  }

  /** The words of a visible code, for its players' account page. */
  words(code: ShareCodeRow): string | null {
    const secret = this.hosts.config().shareCodeSecret;
    return secret ? deriveShareWords(secret, code.id) : null;
  }

  // ---- The host's side ----

  /** The person a code is for: the event's host, or its guest reader. */
  async readerOf(event: HostEvent): Promise<HostPerson | null> {
    const id = event.kind === "outside" ? event.hostPersonId : event.guestReaderId;
    return id ? this.hosts.store.getPerson(id) : null;
  }

  /**
   * Only failures count (persona tests, S2-1): a reader re-opening codes she
   * already opened, a dozen times an evening, is never locked out by it.
   */
  private lockedOut(personId: string): boolean {
    const now = this.now();
    const recent = (this.failures.get(personId) ?? []).filter((t) => t > now - 24 * 3600_000);
    this.failures.set(personId, recent);
    const hour = recent.filter((t) => t > now - 3600_000).length;
    return hour >= REDEEM_PER_HOUR || recent.length >= REDEEM_PER_DAY;
  }

  private failed(personId: string): void {
    this.failures.set(personId, [...(this.failures.get(personId) ?? []), this.now()]);
  }

  /**
   * Redeems words for this reader: a code ref; "paused" when she has had too
   * many failures lately (the same answer for every code, right or wrong); or
   * null (every failure the same). A code she already opened re-opens first,
   * uncounted and never paused.
   */
  async redeem(person: HostPerson, words: unknown): Promise<string | "paused" | null> {
    const norm = normalizeWords(words);
    const code = norm ? await this.hosts.store.codeByHash(this.hosts.shareHash(norm)) : null;
    if (code && code.redeemedBy === person.id) {
      const ref = await this.reopen(person, code);
      if (ref) return ref;
    }
    if (this.lockedOut(person.id)) return "paused";
    const ref = code ? await this.firstOpen(person, code) : null;
    if (!ref) this.failed(person.id);
    return ref;
  }

  /** Whether this person may read this code now: its reader, approved, the code live and still shareable. */
  private async readable(person: HostPerson, code: ShareCodeRow): Promise<boolean> {
    if (code.stoppedAt !== null) return false;
    const event = this.hosts.eventById(code.eventId) ?? (await this.hosts.store.getEvent(code.eventId));
    if (!event?.shareCodes) return false; // the level was lowered: codes no longer open
    // Access lasts only while this person is still the event's reader (an admin can reassign or suspend).
    const reader = await this.readerOf(event);
    if (!reader || reader.id !== person.id || reader.status !== "approved") return false;
    return this.stillShareable(code);
  }

  private async reopen(person: HostPerson, code: ShareCodeRow): Promise<string | null> {
    if ((code.accessUntil ?? 0) <= this.now()) return null;
    return (await this.readable(person, code)) ? this.hosts.ref("code", person.id, code.id) : null;
  }

  private async firstOpen(person: HostPerson, code: ShareCodeRow): Promise<string | null> {
    const now = this.now();
    if (now < code.visibleAt) return null;
    if (code.redeemedBy !== null) return null; // someone else's, or hers and past its window
    if (!(await this.readable(person, code))) return null;
    if (now >= code.expiresAt) return null;
    if (!(await this.hosts.store.redeemCode(code.id, person.id, now, now + CODE_ACCESS_MS))) return null;
    return this.hosts.ref("code", person.id, code.id);
  }

  /**
   * The codes this reader has opened, while she can still read them, newest
   * first, so she never re-types them. A code stopped since stays listed and
   * opens like any unavailable code: the players were told she "will see that
   * it no longer opens".
   */
  async openedCodes(person: HostPerson): Promise<Array<{ codeRef: string; eventName: string; openedAt: number; until: number }>> {
    const now = this.now();
    const out: Array<{ codeRef: string; eventName: string; openedAt: number; until: number }> = [];
    for (const code of await this.hosts.store.codesForReader(person.id)) {
      if ((code.accessUntil ?? 0) <= now || code.redeemedAt === null) continue;
      const event = this.hosts.eventById(code.eventId) ?? (await this.hosts.store.getEvent(code.eventId));
      out.push({ codeRef: this.hosts.ref("code", person.id, code.id), eventName: event?.name ?? "", openedAt: code.redeemedAt, until: code.accessUntil! });
    }
    return out.sort((a, b) => b.openedAt - a.openedAt);
  }

  /** The snapshot for its reader, while access holds; logs the opening (H10, H14). */
  async viewCode(person: HostPerson, codeRef: unknown): Promise<{ snapshot: ShareSnapshot; until: number; reader: string; openedAt: number } | null> {
    if (typeof codeRef !== "string" || !codeRef) return null;
    const now = this.now();
    for (const code of await this.hosts.store.codesForReader(person.id)) {
      if (this.hosts.ref("code", person.id, code.id) !== codeRef) continue;
      if ((code.accessUntil ?? 0) <= now || !(await this.readable(person, code))) return null;
      await this.hosts.store.addAccess(code.id, person.id, now);
      return { snapshot: code.snapshot, until: code.accessUntil!, reader: person.displayName, openedAt: now };
    }
    return null;
  }

  /** The constant floor every redemption answer waits for (§B.3). */
  static floor(startedAt: number): Promise<void> {
    const wait = Math.max(0, REDEEM_FLOOR_MS - (Date.now() - startedAt));
    return new Promise((r) => setTimeout(r, wait));
  }
}
