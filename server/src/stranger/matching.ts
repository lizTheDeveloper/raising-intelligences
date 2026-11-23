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
 *   their own seat token. Nobody else can ever sit in a stranger game.
 * - The join window: if one doesn't arrive in time their seat is removed (so
 *   one human, nothing due), and the one who came can requeue at their
 *   original place. If neither arrives the game is discarded.
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
}

export interface StrangerRunSeats {
  gameId: string;
  meetupCode: string | null;
  parent1: string;
  parent2: string;
}

export interface MatchingHooks {
  createGame(host: QueueEntry, partner: QueueEntry): Promise<{ gameId: string; tokens: Record<StrangerSlot, string> }>;
  discardGame(gameId: string): void;
  removeSeat(gameId: string, slot: StrangerSlot): void;
  notifyNoShow(gameId: string, presentSlot: StrangerSlot): void;
}

interface Run {
  gameId: string;
  meetupCode: string | null;
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
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      age: AgeVerification;
      store: StrangerStore;
      config: () => StrangerConfig;
      hooks: MatchingHooks;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async join(mxid: string, meetupCode: string | null, displayName: string, childName: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const pool = await this.deps.age.adultForPool(mxid);
    if (!pool.ok) return { ok: false, status: 403, error: "Pass the age check first." };
    const subject = await this.deps.age.subjectHash(mxid);
    if (await this.deps.store.isSuspended(subject)) return { ok: false, status: 403, error: "This account can't use stranger mode right now." };
    if (this.matched.has(mxid)) return { ok: true };
    const existing = this.queue.find((e) => e.mxid === mxid);
    if (existing) {
      existing.displayName = displayName;
      existing.childName = childName;
      return { ok: true };
    }
    this.queue.push({ mxid, subject, meetupCode, displayName, childName, queuedAt: this.now(), seq: ++this.seq });
    await this.runMatch(meetupCode);
    return { ok: true };
  }

  leave(mxid: string): void {
    this.queue = this.queue.filter((e) => e.mxid !== mxid);
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
    const mine = this.queue.find((e) => e.mxid === mxid);
    if (!mine) return { status: "none" };
    const same = this.sorted(mine.meetupCode);
    return { status: "waiting", position: same.indexOf(mine) + 1, count: same.length };
  }

  /** Is this a stranger game (as far as this process knows, without I/O)? */
  isRun(gameId: string): boolean {
    return this.runs.has(gameId) || !!this.seatCache.get(gameId);
  }

  /** Whose seat is whose in a stranger game, or null if it isn't one. Survives a restart (stored). */
  async runFor(gameId: string): Promise<StrangerRunSeats | null> {
    const live = this.runs.get(gameId);
    if (live) return { gameId, meetupCode: live.meetupCode, parent1: live.entries.parent1.subject, parent2: live.entries.parent2.subject };
    if (this.seatCache.has(gameId)) return this.seatCache.get(gameId) ?? null;
    const row = await this.deps.store.getRun(gameId);
    this.seatCache.set(gameId, row);
    return row;
  }

  markArrived(gameId: string, slot: StrangerSlot): void {
    const run = this.runs.get(gameId);
    if (!run || run.absent) return;
    run.arrived.add(slot);
    if (run.arrived.size === 2 && run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
  }

  /** The one who came, after a no-show: back in the queue at their original place. */
  async requeue(mxid: string, gameId: string): Promise<boolean> {
    const run = this.runs.get(gameId);
    if (!run || !run.absent) return false;
    const present: StrangerSlot = run.absent === "parent1" ? "parent2" : "parent1";
    const entry = run.entries[present];
    if (entry.mxid !== mxid) return false;
    this.endRun(gameId);
    this.deps.hooks.discardGame(gameId);
    const pool = await this.deps.age.adultForPool(mxid);
    if (!pool.ok) return false;
    this.queue.push({ ...entry });
    await this.runMatch(entry.meetupCode);
    return true;
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
      const waiting = this.sorted(meetupCode);
      // Re-check every candidate now: anyone who stopped being an eligible
      // adult while waiting leaves the queue.
      for (const e of waiting) {
        const pool = await this.deps.age.adultForPool(e.mxid);
        if (!pool.ok || (await this.deps.store.isSuspended(e.subject))) this.leave(e.mxid);
      }
      const eligible = this.sorted(meetupCode);
      let pair: [QueueEntry, QueueEntry] | null = null;
      outer: for (let i = 0; i < eligible.length; i++) {
        for (let j = i + 1; j < eligible.length; j++) {
          if (!(await this.deps.store.isBlocked(eligible[i].subject, eligible[j].subject))) {
            pair = [eligible[i], eligible[j]];
            break outer;
          }
        }
      }
      if (!pair) return;
      await this.makeRun(pair[0], pair[1]);
    }
  }

  private async makeRun(host: QueueEntry, partner: QueueEntry): Promise<void> {
    this.leave(host.mxid);
    this.leave(partner.mxid);
    const { gameId, tokens } = await this.deps.hooks.createGame(host, partner);
    await this.deps.store.createRun({ gameId, meetupCode: host.meetupCode, parent1: host.subject, parent2: partner.subject });
    const run: Run = {
      gameId,
      meetupCode: host.meetupCode,
      entries: { parent1: host, parent2: partner },
      tokens,
      arrived: new Set(),
      timer: null,
      absent: null,
    };
    run.timer = setTimeout(() => this.windowEnd(gameId), this.deps.config().joinWindowMs);
    run.timer.unref?.();
    this.runs.set(gameId, run);
    this.matched.set(host.mxid, { gameId, slot: "parent1" });
    this.matched.set(partner.mxid, { gameId, slot: "parent2" });
    logger.info("stranger_matched", { gameId, meetup: host.meetupCode });
  }

  private windowEnd(gameId: string): void {
    const run = this.runs.get(gameId);
    if (!run) return;
    run.timer = null;
    const absent = SLOTS.filter((s) => !run.arrived.has(s));
    if (absent.length === 0) return;
    if (absent.length === 2) {
      this.endRun(gameId);
      this.deps.hooks.discardGame(gameId);
      logger.info("stranger_match_lapsed", { gameId });
      return;
    }
    const gone = absent[0];
    const present: StrangerSlot = gone === "parent1" ? "parent2" : "parent1";
    run.absent = gone;
    this.matched.delete(run.entries[gone].mxid);
    // Their seat goes: one human in the game, so nothing is ever due for it.
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
    // The seat map stays known (cached) so the discarded game still refuses joins.
    this.seatCache.set(gameId, { gameId, meetupCode: run.meetupCode, parent1: run.entries.parent1.subject, parent2: run.entries.parent2.subject });
  }
}
