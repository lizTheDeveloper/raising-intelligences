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
  getRun(gameId: string): Promise<{ gameId: string; meetupCode: string | null; parent1: string; parent2: string } | null>;
  /** Two accounts that must never be matched again (either reported the other). Order doesn't matter. */
  addBlock(a: string, b: string): Promise<void>;
  isBlocked(a: string, b: string): Promise<boolean>;
  /** Kept out of the pool pending review of a report. */
  suspend(subject: string, reason: string): Promise<void>;
  isSuspended(subject: string): Promise<boolean>;
  lift(subject: string): Promise<void>;
}

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
  runs = new Map<string, { gameId: string; meetupCode: string | null; parent1: string; parent2: string }>();
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
  constructor(private readonly db: Pick<Pool, "query">) {}

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
    const r = await this.db.query(`SELECT game_id, meetup_code, parent1_subject, parent2_subject FROM stranger_runs WHERE game_id = $1`, [gameId]);
    const x = r.rows[0];
    return x ? { gameId: x.game_id, meetupCode: x.meetup_code, parent1: x.parent1_subject, parent2: x.parent2_subject } : null;
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
}
