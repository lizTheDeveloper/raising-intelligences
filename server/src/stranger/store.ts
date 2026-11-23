import type { Pool } from "pg";

/**
 * Stranger-mode records. Every account appears only as `subject`: an HMAC of
 * its Matrix id (identity.ts subjectHash), never the id itself. There is no
 * date of birth anywhere in here, by design — an age check stores its
 * outcome (adult / minor) and nothing it was computed from.
 */

export type AgeOutcome = "adult" | "minor";

export interface AgeVerificationRow {
  subject: string;
  outcome: AgeOutcome;
  /** Was the check made with a live Identity key? A test-mode check never admits anyone in production. */
  livemode: boolean;
  verifiedAt: number;
  sessionId: string;
}

export interface VerificationSessionRow {
  sessionId: string;
  subject: string;
  createdAt: number;
}

export interface ConsentRow {
  subject: string;
  version: string;
  at: number;
}

export interface StrangerStore {
  recordConsent(row: ConsentRow): Promise<void>;
  getConsent(subject: string): Promise<ConsentRow | null>;
  addVerificationSession(row: VerificationSessionRow): Promise<void>;
  getVerificationSession(sessionId: string): Promise<VerificationSessionRow | null>;
  latestVerificationSession(subject: string): Promise<VerificationSessionRow | null>;
  countVerificationSessionsSince(subject: string, sinceMs: number): Promise<number>;
  getVerification(subject: string): Promise<AgeVerificationRow | null>;
  /** Write an outcome. A stored "minor" is final: it is never replaced. */
  setVerification(row: AgeVerificationRow): Promise<AgeVerificationRow>;
  /**
   * Take one of today's ID-check slots (1..max) atomically: a unique
   * (subject, day, attempt) row. Returns the attempt number, or null when
   * all are taken. Concurrent callers can never both get the same slot.
   */
  reserveCheckSlot(subject: string, day: string, max: number): Promise<number | null>;
  /**
   * Bind a document (keyed hash of its number) to an account. True when the
   * document is now, or already was, this account's; false when it belongs
   * to another account.
   */
  bindDocument(docHash: string, subject: string, at: number): Promise<boolean>;
  /** A stranger game's seats: which account (subject) each seat belongs to. */
  createRun(row: { gameId: string; meetupCode: string | null; parent1: string; parent2: string }): Promise<void>;
  getRun(gameId: string): Promise<{ gameId: string; meetupCode: string | null; parent1: string; parent2: string; discarded?: boolean } | null>;
  /** The match lapsed or was given up: the game never seats anyone again. */
  discardRun(gameId: string): Promise<void>;
  /** Two accounts that must never be matched again (either reported the other). Order doesn't matter. */
  addBlock(a: string, b: string): Promise<void>;
  isBlocked(a: string, b: string): Promise<boolean>;
  /** Kept out of the pool pending review of a report. */
  suspend(subject: string, reason: string): Promise<void>;
  isSuspended(subject: string): Promise<boolean>;
  lift(subject: string): Promise<void>;
  /**
   * Lift the suspension in ONE step, only if no open or upheld report against
   * this subject exists at that moment. False if a report still holds it.
   */
  liftIfUnheld(subject: string): Promise<boolean>;
  /** False when this reporter already has a report on this game (one per seat per game). */
  addReport(row: StrangerReport): Promise<boolean>;
  /**
   * File a report, deciding its status, blocking the pair and (for `open`)
   * suspending the reported account — all as ONE atomic step, so parallel
   * reports can't each see room under the cap. `row.status` is the
   * requested status ("open", or "counter" when the reporter failed a
   * re-check); it becomes "counter" if the reporter was already reported in
   * this game or is suspended, else "review" if the reporter is at the cap
   * or has an unfounded (lifted) report since `unfoundedSince`. Returns the
   * filed status, or null if this reporter already reported this game.
   */
  fileReport(row: StrangerReport, rules: { cap: number; capSince: number; unfoundedSince: number }): Promise<StrangerReport["status"] | null>;
  /** Oldest first. `statuses` filters; default every status. */
  listReports(limit: number, opts?: { statuses?: readonly StrangerReport["status"][]; offset?: number }): Promise<StrangerReport[]>;
  reportsBy(reporter: string): Promise<StrangerReport[]>;
  /** The handle exchange's final outcome for a game, persisted so a "no" survives a restart. */
  closeExchange(gameId: string, outcome: "closed" | "revealed"): Promise<void>;
  exchangeOutcome(gameId: string): Promise<"closed" | "revealed" | null>;
  getReport(id: string): Promise<StrangerReport | null>;
  reportsForGame(gameId: string): Promise<StrangerReport[]>;
  reportsAgainst(subject: string): Promise<StrangerReport[]>;
  /** Only an open or counter report can be resolved; false if it already was. */
  resolveReport(id: string, resolution: "lifted" | "kept" | "dismissed"): Promise<boolean>;
  gameReported(gameId: string): Promise<boolean>;
}

export interface StrangerReport {
  id: string;
  gameId: string;
  reporter: string;
  reported: string;
  reason: string;
  createdAt: number;
  /**
   * open: the reported account was suspended pending review.
   * counter: filed by a seat that had itself been reported (or whose own
   *   standing failed a re-check): reviewed, never an automatic suspension.
   * review: filed by a reporter over their cap, or one with an unfounded
   *   (lifted) report: reviewed, never an automatic suspension.
   * lifted / kept / dismissed: an admin's decision.
   */
  status: "open" | "counter" | "review" | "lifted" | "kept" | "dismissed";
}

/** Reports waiting on an admin. */
export const UNRESOLVED_STATUSES: readonly StrangerReport["status"][] = ["open", "counter", "review"];

/** Reports that hold a suspension in place. */
export const HOLDING_STATUSES: ReadonlySet<StrangerReport["status"]> = new Set(["open", "kept"]);

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class InMemoryStrangerStore implements StrangerStore {
  consents = new Map<string, ConsentRow>();
  sessions = new Map<string, VerificationSessionRow>();
  verifications = new Map<string, AgeVerificationRow>();

  async recordConsent(row: ConsentRow): Promise<void> {
    this.consents.set(row.subject, { ...row });
  }
  async getConsent(subject: string): Promise<ConsentRow | null> {
    return this.consents.get(subject) ?? null;
  }
  async addVerificationSession(row: VerificationSessionRow): Promise<void> {
    this.sessions.set(row.sessionId, { ...row });
  }
  async getVerificationSession(sessionId: string): Promise<VerificationSessionRow | null> {
    return this.sessions.get(sessionId) ?? null;
  }
  async latestVerificationSession(subject: string): Promise<VerificationSessionRow | null> {
    let best: VerificationSessionRow | null = null;
    for (const s of this.sessions.values()) {
      if (s.subject === subject && (!best || s.createdAt >= best.createdAt)) best = s;
    }
    return best;
  }
  async countVerificationSessionsSince(subject: string, sinceMs: number): Promise<number> {
    let n = 0;
    for (const s of this.sessions.values()) if (s.subject === subject && s.createdAt >= sinceMs) n++;
    return n;
  }
  async getVerification(subject: string): Promise<AgeVerificationRow | null> {
    const v = this.verifications.get(subject);
    return v ? { ...v } : null;
  }
  async setVerification(row: AgeVerificationRow): Promise<AgeVerificationRow> {
    const existing = this.verifications.get(row.subject);
    if (existing?.outcome === "minor") return { ...existing };
    this.verifications.set(row.subject, { ...row });
    return { ...row };
  }
  runs = new Map<string, { gameId: string; meetupCode: string | null; parent1: string; parent2: string; discarded?: boolean }>();
  async discardRun(gameId: string): Promise<void> {
    const r = this.runs.get(gameId);
    if (r) r.discarded = true;
  }
  blocks = new Set<string>();
  suspended = new Map<string, string>();
  async createRun(row: { gameId: string; meetupCode: string | null; parent1: string; parent2: string }): Promise<void> {
    this.runs.set(row.gameId, { ...row });
  }
  async getRun(gameId: string) {
    const r = this.runs.get(gameId);
    return r ? { ...r } : null;
  }
  async addBlock(a: string, b: string): Promise<void> {
    this.blocks.add(pairKey(a, b));
  }
  async isBlocked(a: string, b: string): Promise<boolean> {
    return this.blocks.has(pairKey(a, b));
  }
  async suspend(subject: string, reason: string): Promise<void> {
    this.suspended.set(subject, reason);
  }
  async isSuspended(subject: string): Promise<boolean> {
    return this.suspended.has(subject);
  }
  async lift(subject: string): Promise<void> {
    this.suspended.delete(subject);
  }
  async liftIfUnheld(subject: string): Promise<boolean> {
    // Synchronous check-and-delete: atomic in a single-threaded process.
    if ([...this.reports.values()].some((r) => r.reported === subject && HOLDING_STATUSES.has(r.status))) return false;
    this.suspended.delete(subject);
    return true;
  }
  exchanges = new Map<string, "closed" | "revealed">();
  async closeExchange(gameId: string, outcome: "closed" | "revealed"): Promise<void> {
    if (!this.exchanges.has(gameId)) this.exchanges.set(gameId, outcome);
  }
  async exchangeOutcome(gameId: string): Promise<"closed" | "revealed" | null> {
    return this.exchanges.get(gameId) ?? null;
  }
  async reportsBy(reporter: string): Promise<StrangerReport[]> {
    return [...this.reports.values()].filter((r) => r.reporter === reporter).map((r) => ({ ...r }));
  }
  reports = new Map<string, StrangerReport>();
  async addReport(row: StrangerReport): Promise<boolean> {
    if ([...this.reports.values()].some((r) => r.gameId === row.gameId && r.reporter === row.reporter)) return false;
    this.reports.set(row.id, { ...row });
    return true;
  }
  async reportsForGame(gameId: string): Promise<StrangerReport[]> {
    return [...this.reports.values()].filter((r) => r.gameId === gameId).map((r) => ({ ...r }));
  }
  async fileReport(row: StrangerReport, rules: { cap: number; capSince: number; unfoundedSince: number }): Promise<StrangerReport["status"] | null> {
    // No await from here to the end: atomic in one event-loop turn.
    const all = [...this.reports.values()];
    if (all.some((r) => r.gameId === row.gameId && r.reporter === row.reporter)) return null;
    const wasReported = all.some((r) => r.gameId === row.gameId && r.reported === row.reporter && HOLDING_STATUSES.has(r.status));
    const mine = all.filter((r) => r.reporter === row.reporter);
    const atCap = mine.filter((r) => r.createdAt >= rules.capSince && (r.status === "open" || r.status === "kept" || r.status === "lifted")).length >= rules.cap;
    const unfounded = mine.some((r) => r.status === "lifted" && r.createdAt >= rules.unfoundedSince);
    const status: StrangerReport["status"] =
      row.status === "counter" || wasReported || this.suspended.has(row.reporter) ? "counter" : atCap || unfounded ? "review" : "open";
    this.reports.set(row.id, { ...row, status });
    this.blocks.add(pairKey(row.reporter, row.reported));
    if (status === "open") this.suspended.set(row.reported, "report");
    return status;
  }
  async reportsAgainst(subject: string): Promise<StrangerReport[]> {
    return [...this.reports.values()].filter((r) => r.reported === subject).map((r) => ({ ...r }));
  }
  async listReports(limit: number, opts: { statuses?: readonly StrangerReport["status"][]; offset?: number } = {}): Promise<StrangerReport[]> {
    const off = opts.offset ?? 0;
    return [...this.reports.values()]
      .filter((r) => !opts.statuses || opts.statuses.includes(r.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(off, off + limit)
      .map((r) => ({ ...r }));
  }
  async getReport(id: string): Promise<StrangerReport | null> {
    const r = this.reports.get(id);
    return r ? { ...r } : null;
  }
  async resolveReport(id: string, resolution: "lifted" | "kept" | "dismissed"): Promise<boolean> {
    const r = this.reports.get(id);
    if (!r || !UNRESOLVED_STATUSES.includes(r.status)) return false;
    r.status = resolution;
    return true;
  }
  async gameReported(gameId: string): Promise<boolean> {
    return [...this.reports.values()].some((r) => r.gameId === gameId);
  }
  slots = new Set<string>();
  documents = new Map<string, string>();
  async reserveCheckSlot(subject: string, day: string, max: number): Promise<number | null> {
    // No await between the check and the insert: atomic in one event loop turn.
    for (let attempt = 1; attempt <= max; attempt++) {
      const k = `${subject}|${day}|${attempt}`;
      if (!this.slots.has(k)) {
        this.slots.add(k);
        return attempt;
      }
    }
    return null;
  }
  async bindDocument(docHash: string, subject: string): Promise<boolean> {
    const owner = this.documents.get(docHash);
    if (owner === undefined) {
      this.documents.set(docHash, subject);
      return true;
    }
    return owner === subject;
  }
}

export class PgStrangerStore implements StrangerStore {
  constructor(private readonly db: Pick<Pool, "query"> & Partial<Pick<Pool, "connect">>) {}

  async recordConsent(row: ConsentRow): Promise<void> {
    await this.db.query(
      `INSERT INTO stranger_consents (subject, version, consented_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT (subject) DO UPDATE SET version = EXCLUDED.version, consented_at = EXCLUDED.consented_at`,
      [row.subject, row.version, row.at],
    );
  }
  async getConsent(subject: string): Promise<ConsentRow | null> {
    const r = await this.db.query(
      `SELECT subject, version, (extract(epoch from consented_at) * 1000)::bigint AS at FROM stranger_consents WHERE subject = $1`,
      [subject],
    );
    return r.rows[0] ? { subject: r.rows[0].subject, version: r.rows[0].version, at: Number(r.rows[0].at) } : null;
  }
  async addVerificationSession(row: VerificationSessionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO stranger_verification_sessions (session_id, subject, created_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT (session_id) DO NOTHING`,
      [row.sessionId, row.subject, row.createdAt],
    );
  }
  private toSession(r: { session_id: string; subject: string; at: string | number }): VerificationSessionRow {
    return { sessionId: r.session_id, subject: r.subject, createdAt: Number(r.at) };
  }
  async getVerificationSession(sessionId: string): Promise<VerificationSessionRow | null> {
    const r = await this.db.query(
      `SELECT session_id, subject, (extract(epoch from created_at) * 1000)::bigint AS at FROM stranger_verification_sessions WHERE session_id = $1`,
      [sessionId],
    );
    return r.rows[0] ? this.toSession(r.rows[0]) : null;
  }
  async latestVerificationSession(subject: string): Promise<VerificationSessionRow | null> {
    const r = await this.db.query(
      `SELECT session_id, subject, (extract(epoch from created_at) * 1000)::bigint AS at FROM stranger_verification_sessions
       WHERE subject = $1 ORDER BY created_at DESC LIMIT 1`,
      [subject],
    );
    return r.rows[0] ? this.toSession(r.rows[0]) : null;
  }
  async countVerificationSessionsSince(subject: string, sinceMs: number): Promise<number> {
    const r = await this.db.query(
      `SELECT count(*)::int AS n FROM stranger_verification_sessions WHERE subject = $1 AND created_at >= to_timestamp($2 / 1000.0)`,
      [subject, sinceMs],
    );
    return r.rows[0]?.n ?? 0;
  }
  private toVerification(r: { subject: string; outcome: AgeOutcome; livemode: boolean; at: string | number; session_id: string }): AgeVerificationRow {
    return { subject: r.subject, outcome: r.outcome, livemode: r.livemode, verifiedAt: Number(r.at), sessionId: r.session_id };
  }
  async getVerification(subject: string): Promise<AgeVerificationRow | null> {
    const r = await this.db.query(
      `SELECT subject, outcome, livemode, (extract(epoch from verified_at) * 1000)::bigint AS at, session_id
       FROM stranger_age_verifications WHERE subject = $1`,
      [subject],
    );
    return r.rows[0] ? this.toVerification(r.rows[0]) : null;
  }
  async setVerification(row: AgeVerificationRow): Promise<AgeVerificationRow> {
    // A stored minor outcome is final: the WHERE leaves it untouched.
    await this.db.query(
      `INSERT INTO stranger_age_verifications (subject, outcome, livemode, verified_at, session_id)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5)
       ON CONFLICT (subject) DO UPDATE SET outcome = EXCLUDED.outcome, livemode = EXCLUDED.livemode,
         verified_at = EXCLUDED.verified_at, session_id = EXCLUDED.session_id
       WHERE stranger_age_verifications.outcome <> 'minor'`,
      [row.subject, row.outcome, row.livemode, row.verifiedAt, row.sessionId],
    );
    return (await this.getVerification(row.subject))!;
  }

  async reserveCheckSlot(subject: string, day: string, max: number): Promise<number | null> {
    // The primary key does the locking: of N concurrent inserts for one
    // (subject, day, attempt), exactly one succeeds.
    for (let attempt = 1; attempt <= max; attempt++) {
      const r = await this.db.query(
        `INSERT INTO stranger_check_slots (subject, day, attempt, taken_at) VALUES ($1, $2, $3, now())
         ON CONFLICT DO NOTHING RETURNING attempt`,
        [subject, day, attempt],
      );
      if (r.rows.length > 0) return attempt;
    }
    return null;
  }
  async bindDocument(docHash: string, subject: string, at: number): Promise<boolean> {
    await this.db.query(
      `INSERT INTO stranger_documents (doc_hash, subject, bound_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT (doc_hash) DO NOTHING`,
      [docHash, subject, at],
    );
    const r = await this.db.query(`SELECT subject FROM stranger_documents WHERE doc_hash = $1`, [docHash]);
    return r.rows[0]?.subject === subject;
  }

  async createRun(row: { gameId: string; meetupCode: string | null; parent1: string; parent2: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO stranger_runs (game_id, meetup_code, parent1_subject, parent2_subject, created_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (game_id) DO NOTHING`,
      [row.gameId, row.meetupCode, row.parent1, row.parent2],
    );
  }
  async getRun(gameId: string) {
    const r = await this.db.query(
      `SELECT game_id, meetup_code, parent1_subject, parent2_subject, discarded_at FROM stranger_runs WHERE game_id = $1`,
      [gameId],
    );
    const x = r.rows[0];
    return x
      ? { gameId: x.game_id, meetupCode: x.meetup_code, parent1: x.parent1_subject, parent2: x.parent2_subject, ...(x.discarded_at ? { discarded: true } : {}) }
      : null;
  }
  async discardRun(gameId: string): Promise<void> {
    await this.db.query(`UPDATE stranger_runs SET discarded_at = now() WHERE game_id = $1 AND discarded_at IS NULL`, [gameId]);
  }
  async addBlock(a: string, b: string): Promise<void> {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    await this.db.query(`INSERT INTO stranger_blocks (subject_a, subject_b, created_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`, [lo, hi]);
  }
  async isBlocked(a: string, b: string): Promise<boolean> {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const r = await this.db.query(`SELECT 1 FROM stranger_blocks WHERE subject_a = $1 AND subject_b = $2`, [lo, hi]);
    return r.rows.length > 0;
  }
  async suspend(subject: string, reason: string): Promise<void> {
    await this.db.query(
      `INSERT INTO stranger_suspensions (subject, reason, created_at) VALUES ($1, $2, now())
       ON CONFLICT (subject) DO UPDATE SET reason = EXCLUDED.reason`,
      [subject, reason],
    );
  }
  async isSuspended(subject: string): Promise<boolean> {
    const r = await this.db.query(`SELECT 1 FROM stranger_suspensions WHERE subject = $1`, [subject]);
    return r.rows.length > 0;
  }
  async lift(subject: string): Promise<void> {
    await this.db.query(`DELETE FROM stranger_suspensions WHERE subject = $1`, [subject]);
  }
  async liftIfUnheld(subject: string): Promise<boolean> {
    // One statement. A report committed before it holds the suspension; one
    // committed after re-suspends (reportOne suspends after inserting).
    const r = await this.db.query(
      `DELETE FROM stranger_suspensions WHERE subject = $1
         AND NOT EXISTS (SELECT 1 FROM stranger_reports WHERE reported_subject = $1 AND status IN ('open', 'kept'))
       RETURNING subject`,
      [subject],
    );
    if ((r.rowCount ?? 0) > 0) return true;
    const held = await this.db.query(`SELECT 1 FROM stranger_reports WHERE reported_subject = $1 AND status IN ('open', 'kept') LIMIT 1`, [subject]);
    return held.rows.length === 0;
  }
  async closeExchange(gameId: string, outcome: "closed" | "revealed"): Promise<void> {
    await this.db.query(
      `INSERT INTO stranger_exchanges (game_id, outcome, at) VALUES ($1, $2, now()) ON CONFLICT (game_id) DO NOTHING`,
      [gameId, outcome],
    );
  }
  async exchangeOutcome(gameId: string): Promise<"closed" | "revealed" | null> {
    const r = await this.db.query(`SELECT outcome FROM stranger_exchanges WHERE game_id = $1`, [gameId]);
    return (r.rows[0]?.outcome as "closed" | "revealed" | undefined) ?? null;
  }
  reportsBy(reporter: string): Promise<StrangerReport[]> {
    return this.reportsWhere("reporter_subject", reporter);
  }

  async fileReport(row: StrangerReport, rules: { cap: number; capSince: number; unfoundedSince: number }): Promise<StrangerReport["status"] | null> {
    if (!this.db.connect) throw new Error("fileReport needs a pool that can open a transaction");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Serialise every report touching this game or either account. Locks
      // are taken in sorted order, so two reports can never deadlock.
      const keys = [`g:${row.gameId}`, `s:${row.reporter}`, `s:${row.reported}`].sort();
      for (const k of keys) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [k]);
      // Each statement below takes a fresh snapshot, after the locks: it sees
      // every report committed by whoever held them before us.
      const r = await client.query(
        `INSERT INTO stranger_reports (id, game_id, reporter_subject, reported_subject, reason, created_at, status)
         SELECT $1, $2, $3, $4, $5, to_timestamp($6 / 1000.0),
           CASE
             WHEN $7 = 'counter'
               OR EXISTS (SELECT 1 FROM stranger_reports WHERE game_id = $2 AND reported_subject = $3 AND status IN ('open', 'kept'))
               OR EXISTS (SELECT 1 FROM stranger_suspensions WHERE subject = $3)
               THEN 'counter'
             WHEN (SELECT count(*) FROM stranger_reports WHERE reporter_subject = $3 AND created_at >= to_timestamp($8 / 1000.0)
                     AND status IN ('open', 'kept', 'lifted')) >= $9
               OR EXISTS (SELECT 1 FROM stranger_reports WHERE reporter_subject = $3 AND status = 'lifted' AND created_at >= to_timestamp($10 / 1000.0))
               THEN 'review'
             ELSE 'open'
           END
         ON CONFLICT (game_id, reporter_subject) DO NOTHING
         RETURNING status`,
        [row.id, row.gameId, row.reporter, row.reported, row.reason, row.createdAt, row.status, rules.capSince, rules.cap, rules.unfoundedSince],
      );
      const status = (r.rows[0]?.status as StrangerReport["status"] | undefined) ?? null;
      if (status) {
        const [lo, hi] = row.reporter < row.reported ? [row.reporter, row.reported] : [row.reported, row.reporter];
        await client.query(`INSERT INTO stranger_blocks (subject_a, subject_b, created_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`, [lo, hi]);
        if (status === "open") {
          await client.query(
            `INSERT INTO stranger_suspensions (subject, reason, created_at) VALUES ($1, 'report', now())
             ON CONFLICT (subject) DO UPDATE SET reason = EXCLUDED.reason`,
            [row.reported],
          );
        }
      }
      await client.query("COMMIT");
      return status;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private toReport(r: Record<string, unknown>): StrangerReport {
    return {
      id: String(r.id), gameId: String(r.game_id), reporter: String(r.reporter_subject), reported: String(r.reported_subject),
      reason: String(r.reason), createdAt: Number(r.at), status: r.status as StrangerReport["status"],
    };
  }
  async addReport(row: StrangerReport): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO stranger_reports (id, game_id, reporter_subject, reported_subject, reason, created_at, status)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7)
       ON CONFLICT (game_id, reporter_subject) DO NOTHING`,
      [row.id, row.gameId, row.reporter, row.reported, row.reason, row.createdAt, row.status],
    );
    return (r.rowCount ?? 0) > 0;
  }
  private async reportsWhere(col: "game_id" | "reported_subject" | "reporter_subject", v: string): Promise<StrangerReport[]> {
    const r = await this.db.query(
      `SELECT id, game_id, reporter_subject, reported_subject, reason, status, (extract(epoch from created_at) * 1000)::bigint AS at
       FROM stranger_reports WHERE ${col} = $1 ORDER BY created_at`,
      [v],
    );
    return r.rows.map((x) => this.toReport(x));
  }
  reportsForGame(gameId: string): Promise<StrangerReport[]> {
    return this.reportsWhere("game_id", gameId);
  }
  reportsAgainst(subject: string): Promise<StrangerReport[]> {
    return this.reportsWhere("reported_subject", subject);
  }
  async listReports(limit: number, opts: { statuses?: readonly StrangerReport["status"][]; offset?: number } = {}): Promise<StrangerReport[]> {
    const r = await this.db.query(
      `SELECT id, game_id, reporter_subject, reported_subject, reason, status, (extract(epoch from created_at) * 1000)::bigint AS at
       FROM stranger_reports WHERE ($2::text[] IS NULL OR status = ANY($2)) ORDER BY created_at, id LIMIT $1 OFFSET $3`,
      [limit, opts.statuses ? [...opts.statuses] : null, opts.offset ?? 0],
    );
    return r.rows.map((x) => this.toReport(x));
  }
  async getReport(id: string): Promise<StrangerReport | null> {
    const r = await this.db.query(
      `SELECT id, game_id, reporter_subject, reported_subject, reason, status, (extract(epoch from created_at) * 1000)::bigint AS at
       FROM stranger_reports WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? this.toReport(r.rows[0]) : null;
  }
  async resolveReport(id: string, resolution: "lifted" | "kept" | "dismissed"): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE stranger_reports SET status = $2 WHERE id = $1 AND status IN ('open', 'counter', 'review')`,
      [id, resolution],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async gameReported(gameId: string): Promise<boolean> {
    const r = await this.db.query(`SELECT 1 FROM stranger_reports WHERE game_id = $1 LIMIT 1`, [gameId]);
    return r.rows.length > 0;
  }
}
