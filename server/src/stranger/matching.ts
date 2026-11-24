import { logger } from "../logger.js";
import type { StrangerConfig } from "./config.js";
import type { AgeVerification } from "./identity.js";
import type { StrangerStore } from "./store.js";

/**
 * The stranger queue and the matches it makes.
 *
 * - Only verified adults queue, and admission is checked AGAIN at the moment
 *   of matching (a result can change while someone waits).
 * - Pairing is first-come, first-served within one meetup code, skipping any
 *   pair that has blocked each other. (The spec's LLM matchmaker is not built;
 *   at meetup scale the queue is a handful of people and order is fairest.)
 * - The HOST is whoever queued first. They sit as parent1, their child name is
 *   used, and they are the one asked to pay (the payment layer charges
 *   parent1). Ties on the clock break by arrival order.
 * - A match reserves the two seats for those two accounts only, and gives each
 *   their own seat token. Nobody else can ever sit in a stranger game. A
 *   reserved seat is NOT a seat (not in the session, not counted by the
 *   paywall) until its adult actually arrives.
 * - The join window: if one doesn't arrive in time their reservation lapses
 *   (one human, nothing due), and the one who came can requeue at their
 *   original place. If neither arrives the game is discarded. A discarded game
 *   is marked so in the store and never opens again.
 * - Once both have arrived the match is released: the game carries on as an
 *   ordinary two-seat game (seats still bound), and both can queue again later.
 * - A queued player who stops polling (closed tab) drops out of the queue.
 */

export type StrangerSlot = "parent1" | "parent2";

/**
 * The relationship every stranger game is created with — server-set, never
 * from a client. It lets the join path recognise a stranger game from the
 * state it already holds, with no extra I/O (the join handlers are
 * ordering-sensitive: an ordinary game must not wait on anything new).
 */
export const STRANGER_RELATIONSHIP = "co-parents who were never together";

export interface QueueEntry {
  mxid: string;
  subject: string;
  meetupCode: string | null;
  displayName: string;
  childName: string;
  queuedAt: number;
  seq: number;
  lastSeen: number;
  /**
   * The host-tools event (one period of a meetup code) this entry acknowledged
   * and joined under. Entries pair only within one event, so a game is always
   * played on the terms both players accepted.
   */
  eventId?: string | null;
}

export interface StrangerRunSeats {
  gameId: string;
  meetupCode: string | null;
  parent1: string;
  parent2: string;
  discarded?: boolean;
  /** The host-tools event this game was matched at (its code is never stored). */
  eventId?: string | null;
}

/**
 * Host tools (hosts/service.ts) at the queue: which event a meetup code is,
 * and whether this subject may join it now (event open, under capacity, the
 * current card acknowledged, not its host or guest reader).
 */
export interface MatchingGate {
  join(subject: string, meetupCode: string | null): Promise<{ ok: true } | { ok: false; status: number; error: string; card?: unknown }>;
  eventIdFor(meetupCode: string | null): string | null;
  joinWindowMs(eventId: string): number | null;
}

const SEAT_CACHE_MAX = 5000;

export interface MatchingHooks {
  createGame(host: QueueEntry, partner: QueueEntry): Promise<{ gameId: string; tokens: Record<StrangerSlot, string> }>;
  discardGame(gameId: string): void;
  removeSeat(gameId: string, slot: StrangerSlot): void;
  notifyNoShow(gameId: string, presentSlot: StrangerSlot): void;
}

interface Run {
  gameId: string;
  meetupCode: string | null;
  eventId: string | null;
  entries: Record<StrangerSlot, QueueEntry>;
  tokens: Record<StrangerSlot, string>;
  arrived: Set<StrangerSlot>;
  timer: ReturnType<typeof setTimeout> | null;
  absent: StrangerSlot | null;
}

export type PollResult =
  | { status: "waiting"; position: number; count: number }
  | { status: "matched"; gameId: string; slot: StrangerSlot; playerToken: string; partnerName: string }
  | { status: "none" };

const SLOTS: StrangerSlot[] = ["parent1", "parent2"];

export class StrangerMatching {
  private queue: QueueEntry[] = [];
  private matched = new Map<string, { gameId: string; slot: StrangerSlot }>();
  private runs = new Map<string, Run>();
  private seatCache = new Map<string, StrangerRunSeats | null>();
  private seq = 0;
  /**
   * Suspended accounts (a report pending review) who queue: held here, shown
   * "waiting", never matched. Refusing them outright, right after a game,
   * would tell them who reported them.
   */
  private held = new Map<string, QueueEntry>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      age: AgeVerification;
      store: StrangerStore;
      config: () => StrangerConfig;
      hooks: MatchingHooks;
      now?: () => number;
      /** Host tools, when they are on (meetup mode). */
      gate?: () => MatchingGate | null;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async join(mxid: string, meetupCode: string | null, displayName: string, childName: string): Promise<{ ok: true } | { ok: false; status: number; error: string; card?: unknown }> {
    const pool = await this.deps.age.adultForPool(mxid);
    if (!pool.ok) return { ok: false, status: 403, error: "Pass the age check first." };
    const subject = await this.deps.age.subjectHash(mxid);
    const gate = this.deps.gate?.();
    let eventId: string | null = null;
    if (gate) {
      const g = await gate.join(subject, meetupCode);
      if (!g.ok) return g;
      eventId = gate.eventIdFor(meetupCode);
    }
    if (await this.deps.store.isSuspended(subject)) {
      this.hold({ mxid, subject, meetupCode, displayName, childName, queuedAt: this.now(), seq: ++this.seq, lastSeen: this.now(), eventId });
      return { ok: true };
    }
    if (this.matched.has(mxid)) return { ok: true };
    const existing = this.queue.find((e) => e.mxid === mxid);
    if (existing) {
      existing.displayName = displayName;
      existing.childName = childName;
      existing.lastSeen = this.now();
      if (gate) existing.eventId = eventId; // re-joined under a new card (a new period): its terms now
      return { ok: true };
    }
    const now = this.now();
    this.queue.push({ mxid, subject, meetupCode, displayName, childName, queuedAt: now, seq: ++this.seq, lastSeen: now, eventId });
    await this.runMatch(meetupCode);
    return { ok: true };
  }

  leave(mxid: string): void {
    this.queue = this.queue.filter((e) => e.mxid !== mxid);
    this.held.delete(mxid);
  }

  private hold(entry: QueueEntry): void {
    this.queue = this.queue.filter((e) => e.mxid !== entry.mxid);
    const prior = this.held.get(entry.mxid);
    this.held.set(entry.mxid, { ...(prior ?? entry), lastSeen: this.now() });
  }

  poll(mxid: string): PollResult {
    const m = this.matched.get(mxid);
    if (m) {
      const run = this.runs.get(m.gameId);
      if (run) {
        const other = m.slot === "parent1" ? "parent2" : "parent1";
        return { status: "matched", gameId: m.gameId, slot: m.slot, playerToken: run.tokens[m.slot], partnerName: run.entries[other].displayName };
      }
      this.matched.delete(mxid);
    }
    this.pruneIdle();
    const mine = this.held.get(mxid) ?? this.queue.find((e) => e.mxid === mxid);
    if (!mine) return { status: "none" };
    mine.lastSeen = this.now();
    // Privacy review F2: a held (suspended) player is counted, and placed,
    // exactly like a waiting one, in their own count and in everyone else's.
    // Leaving them out made the difference between phones (or a host watching
    // the room) show who had been reported.
    const seen = this.visibleQueue(mine.meetupCode);
    return { status: "waiting", position: seen.indexOf(mine) + 1, count: seen.length };
  }

  /** Everyone who looks like they're waiting at a meetup: the queue plus the held, in arrival order. */
  private visibleQueue(meetupCode: string | null): QueueEntry[] {
    return [...this.queue, ...this.held.values()]
      .filter((e) => e.meetupCode === meetupCode)
      .sort((a, b) => a.queuedAt - b.queuedAt || a.seq - b.seq);
  }

  /** Is this a stranger game (as far as this process knows, without I/O)? */
  isRun(gameId: string): boolean {
    return this.runs.has(gameId) || !!this.seatCache.get(gameId);
  }

  /** Is the join window of this match still open (in this process)? */
  isPending(gameId: string): boolean {
    return this.runs.has(gameId);
  }

  /** The slot a still-reserved, never-taken seat token belongs to, or null. */
  reservedSlot(gameId: string, token: string): StrangerSlot | null {
    const run = this.runs.get(gameId);
    if (!run) return null;
    for (const s of SLOTS) {
      if (run.tokens[s] === token && run.absent !== s && !run.arrived.has(s)) return s;
    }
    return null;
  }

  reservedName(gameId: string, slot: StrangerSlot): string {
    return this.runs.get(gameId)?.entries[slot].displayName ?? "a parent";
  }

  /**
   * After a restart the join window is gone with the process. The one seat
   * that had arrived is all that is left (the other's reservation was never
   * stored): treat it as a no-show now, so the one who came can requeue.
   */
  adoptStranded(seats: StrangerRunSeats, present: StrangerSlot, entry: { mxid: string; displayName: string; childName: string; meetupCode?: string | null }): void {
    if (this.runs.has(seats.gameId)) return;
    const now = this.now();
    // At an event the run stores no code: the pass carries it, and the entry keeps the event.
    const mk = (mxid: string, subject: string, displayName: string): QueueEntry => ({
      mxid, subject, meetupCode: entry.meetupCode ?? seats.meetupCode, displayName, childName: entry.childName, queuedAt: now, seq: ++this.seq, lastSeen: now,
      eventId: seats.eventId ?? null,
    });
    const absent: StrangerSlot = present === "parent1" ? "parent2" : "parent1";
    const entries = {
      [present]: mk(entry.mxid, seats[present], entry.displayName),
      [absent]: mk("", seats[absent], ""),
    } as Record<StrangerSlot, QueueEntry>;
    this.runs.set(seats.gameId, {
      gameId: seats.gameId, meetupCode: seats.meetupCode, eventId: seats.eventId ?? null, entries, tokens: { parent1: "", parent2: "" },
      arrived: new Set([present]), timer: null, absent,
    });
    logger.info("stranger_no_show", { gameId: seats.gameId, afterRestart: true });
  }

  /** Whose seat is whose in a stranger game, or null if it isn't one. Survives a restart (stored). */
  async runFor(gameId: string): Promise<StrangerRunSeats | null> {
    const live = this.runs.get(gameId);
    if (live) return { gameId, meetupCode: live.meetupCode, parent1: live.entries.parent1.subject, parent2: live.entries.parent2.subject, eventId: live.eventId };
    if (this.seatCache.has(gameId)) return this.seatCache.get(gameId) ?? null;
    const row = await this.deps.store.getRun(gameId);
    this.cacheSeats(gameId, row);
    return row;
  }

  private cacheSeats(gameId: string, row: StrangerRunSeats | null): void {
    this.seatCache.delete(gameId);
    this.seatCache.set(gameId, row);
    if (this.seatCache.size > SEAT_CACHE_MAX) this.seatCache.delete(this.seatCache.keys().next().value as string);
  }

  markArrived(gameId: string, slot: StrangerSlot): void {
    const run = this.runs.get(gameId);
    if (!run || run.absent) return;
    run.arrived.add(slot);
    // Both here: the match is done. The game goes on; the matching forgets it.
    if (run.arrived.size === 2) this.endRun(gameId);
  }

  /** The one who came, after a no-show: back in the queue at their original place. */
  async requeue(mxid: string, gameId: string): Promise<boolean> {
    const run = this.runs.get(gameId);
    if (!run || !run.absent) return false;
    const present: StrangerSlot = run.absent === "parent1" ? "parent2" : "parent1";
    const entry = run.entries[present];
    if (entry.mxid !== mxid) return false;
    const pool = await this.deps.age.adultForPool(mxid);
    if (!pool.ok) return false;
    const suspended = await this.deps.store.isSuspended(entry.subject);
    if (this.runs.get(gameId) !== run) return false; // raced with another requeue
    await this.discard(gameId);
    if (suspended) {
      this.hold({ ...entry, lastSeen: this.now() });
      return true;
    }
    // Never twice in the queue (a /queue/join may have landed meanwhile).
    if (!this.matched.has(mxid) && !this.queue.some((e) => e.mxid === mxid)) {
      this.queue.push({ ...entry, lastSeen: this.now() });
    }
    await this.runMatch(entry.meetupCode);
    return true;
  }

  private pruneIdle(): void {
    const cutoff = this.now() - this.deps.config().queueIdleMs;
    this.queue = this.queue.filter((e) => e.lastSeen >= cutoff);
    for (const [k, e] of this.held) if (e.lastSeen < cutoff) this.held.delete(k);
  }

  private sorted(meetupCode: string | null): QueueEntry[] {
    return this.queue
      .filter((e) => e.meetupCode === meetupCode)
      .sort((a, b) => a.queuedAt - b.queuedAt || a.seq - b.seq);
  }

  /** One matching pass at a time. */
  private runMatch(meetupCode: string | null): Promise<void> {
    const next = this.chain.then(() => this.matchOnce(meetupCode)).catch((err) => {
      logger.error("stranger_match_failed", { error: err instanceof Error ? err.message : String(err) });
    });
    this.chain = next;
    return next;
  }

  private async matchOnce(meetupCode: string | null): Promise<void> {
    for (;;) {
      this.pruneIdle();
      const waiting = this.sorted(meetupCode);
      // Re-check every candidate now: anyone who stopped being an eligible
      // adult while waiting leaves the queue.
      for (const e of waiting) {
        const pool = await this.deps.age.adultForPool(e.mxid);
        if (!pool.ok) this.leave(e.mxid);
        else if (await this.deps.store.isSuspended(e.subject)) this.hold(e);
      }
      const eligible = this.sorted(meetupCode);
      let pair: [QueueEntry, QueueEntry] | null = null;
      outer: for (let i = 0; i < eligible.length; i++) {
        for (let j = i + 1; j < eligible.length; j++) {
          if (eligible[i].mxid === eligible[j].mxid || eligible[i].subject === eligible[j].subject) continue;
          if ((eligible[i].eventId ?? null) !== (eligible[j].eventId ?? null)) continue;
          if (!(await this.deps.store.isBlocked(eligible[i].subject, eligible[j].subject))) {
            pair = [eligible[i], eligible[j]];
            break outer;
          }
        }
      }
      if (!pair) return;
      // Either may have left while we were checking.
      if (!this.queue.includes(pair[0]) || !this.queue.includes(pair[1])) continue;
      if (!(await this.makeRun(pair[0], pair[1]))) return;
    }
  }

  /** False when the game couldn't be made: both stay queued, and this pass stops. */
  private async makeRun(host: QueueEntry, partner: QueueEntry): Promise<boolean> {
    let gameId: string;
    let tokens: Record<StrangerSlot, string>;
    const gate = this.deps.gate?.() ?? null;
    const eventId = host.eventId ?? gate?.eventIdFor(host.meetupCode) ?? null;
    // At an event, the run names the event, never its code.
    const storedCode = eventId ? null : host.meetupCode;
    try {
      ({ gameId, tokens } = await this.deps.hooks.createGame(host, partner));
      await this.deps.store.createRun({ gameId, meetupCode: storedCode, parent1: host.subject, parent2: partner.subject, eventId });
    } catch (err) {
      logger.error("stranger_match_create_failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    // Re-checked AFTER the awaits above (making the game took time): either
    // may have become ineligible, or been suspended, in the meantime.
    for (const e of [host, partner]) {
      if (!(await this.deps.age.adultForPool(e.mxid)).ok) this.leave(e.mxid);
      else if (await this.deps.store.isSuspended(e.subject)) this.hold(e);
    }
    if (!this.queue.includes(host) || !this.queue.includes(partner)) {
      // One left (or stopped being eligible) while the game was being made:
      // throw it away, keep the other queued.
      this.cacheSeats(gameId, { gameId, meetupCode: storedCode, parent1: host.subject, parent2: partner.subject, eventId });
      await this.markDiscarded(gameId);
      return true;
    }
    this.leave(host.mxid);
    this.leave(partner.mxid);
    const run: Run = {
      gameId,
      meetupCode: host.meetupCode,
      eventId,
      entries: { parent1: host, parent2: partner },
      tokens,
      arrived: new Set(),
      timer: null,
      absent: null,
    };
    const windowMs = (eventId ? gate?.joinWindowMs(eventId) : null) ?? this.deps.config().joinWindowMs;
    run.timer = setTimeout(() => this.windowEnd(gameId), windowMs);
    run.timer.unref?.();
    this.runs.set(gameId, run);
    this.matched.set(host.mxid, { gameId, slot: "parent1" });
    this.matched.set(partner.mxid, { gameId, slot: "parent2" });
    // Never the meetup code itself (privacy review F5): it names the event, and logs go to Loki.
    logger.info("stranger_matched", { gameId, atMeetup: host.meetupCode !== null });
    return true;
  }

  private windowEnd(gameId: string): void {
    const run = this.runs.get(gameId);
    if (!run) return;
    run.timer = null;
    const absent = SLOTS.filter((s) => !run.arrived.has(s));
    if (absent.length === 0) return;
    if (absent.length === 2) {
      void this.discard(gameId).catch((err) => logger.error("stranger_discard_failed", { gameId, error: String(err) }));
      logger.info("stranger_match_lapsed", { gameId });
      return;
    }
    const gone = absent[0];
    const present: StrangerSlot = gone === "parent1" ? "parent2" : "parent1";
    run.absent = gone;
    this.matched.delete(run.entries[gone].mxid);
    // Their reservation lapses: one human in the game, so nothing is ever due.
    this.deps.hooks.removeSeat(gameId, gone);
    this.deps.hooks.notifyNoShow(gameId, present);
    logger.info("stranger_no_show", { gameId });
  }

  private endRun(gameId: string): void {
    const run = this.runs.get(gameId);
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    for (const s of SLOTS) {
      const m = this.matched.get(run.entries[s].mxid);
      if (m?.gameId === gameId) this.matched.delete(run.entries[s].mxid);
    }
    this.runs.delete(gameId);
    // The seat map stays known, so the game still recognises its two adults.
    this.cacheSeats(gameId, {
      gameId, meetupCode: run.eventId ? null : run.meetupCode, parent1: run.entries.parent1.subject, parent2: run.entries.parent2.subject, eventId: run.eventId,
    });
  }

  /** The event a stranger game was matched at, as far as this process knows (no I/O). */
  eventIdOf(gameId: string): string | null {
    return this.runs.get(gameId)?.eventId ?? this.seatCache.get(gameId)?.eventId ?? null;
  }

  /** The match is over for good: marked in the store, so no seat ever opens again. */
  private async discard(gameId: string): Promise<void> {
    this.endRun(gameId);
    this.deps.hooks.discardGame(gameId);
    await this.markDiscarded(gameId);
  }

  private async markDiscarded(gameId: string): Promise<void> {
    const cached = this.seatCache.get(gameId);
    if (cached) this.cacheSeats(gameId, { ...cached, discarded: true });
    await this.deps.store.discardRun(gameId);
  }
}
