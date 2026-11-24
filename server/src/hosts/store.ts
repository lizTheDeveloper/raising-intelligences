import type { Pool } from "pg";
import type {
  AckRow, FrozenTerms, HostEvent, HostPerson, HostReport, PublishedFunnel, ShareCodeRow, ShareDecision, Slot, UnlinkRequest,
} from "./types.js";

/**
 * Host-tools records (migration 034). People appear only as subjects. No
 * event code or share code is stored in the clear, and no count of codes is
 * ever kept or returned (spec §4.2 rule 7).
 */
export interface HostStore {
  createPerson(p: HostPerson): Promise<boolean>;
  getPerson(id: string): Promise<HostPerson | null>;
  personBySubject(subject: string): Promise<HostPerson | null>;
  listPeople(): Promise<HostPerson[]>;
  updatePerson(id: string, patch: Partial<Pick<HostPerson, "status" | "displayName" | "roleText" | "roleChecked" | "roleCheckedAt" | "hostType" | "organisation">>): Promise<void>;

  createEvent(e: HostEvent): Promise<void>;
  getEvent(id: string): Promise<HostEvent | null>;
  listEvents(): Promise<HostEvent[]>;
  updateEvent(id: string, patch: Partial<HostEvent>): Promise<HostEvent | null>;
  /** Sets the terms only if none are set yet (the first acknowledgement). True if this call set them. */
  freezeTerms(id: string, terms: FrozenTerms, at: number): Promise<boolean>;
  /** Sets the funnel only if it isn't published yet. True if this call set it. */
  publishFunnel(id: string, funnel: PublishedFunnel, at: number): Promise<boolean>;

  saveCard(eventId: string, version: number, card: unknown): Promise<void>;
  getCard(eventId: string, version: number): Promise<unknown | null>;

  addAck(row: AckRow): Promise<void>;
  ackByTokenHash(hash: string): Promise<AckRow | null>;
  bindAck(id: string, subject: string, at: number): Promise<void>;
  acksForSubject(subject: string): Promise<AckRow[]>;
  /** Marks this subject as having joined the queue at this event. */
  markQueued(subject: string, eventId: string, at: number): Promise<void>;
  /** Distinct subjects who joined the queue at this event. */
  countQueued(eventId: string): Promise<number>;
  hasQueued(subject: string, eventId: string): Promise<boolean>;
  unlistAcks(subject: string, eventId: string, at: number): Promise<void>;
  deleteAcks(subject: string, eventId: string): Promise<void>;

  getDecisions(gameId: string): Promise<ShareDecision[]>;
  setDecision(row: ShareDecision): Promise<void>;
  deleteDecisions(gameId: string, slot?: Slot): Promise<void>;

  insertCode(row: ShareCodeRow): Promise<boolean>;
  getCode(id: string): Promise<ShareCodeRow | null>;
  codeByGame(gameId: string): Promise<ShareCodeRow | null>;
  codeByHash(hash: string): Promise<ShareCodeRow | null>;
  /** The codes a host or guest reader has redeemed. */
  codesForReader(hostPersonId: string): Promise<ShareCodeRow[]>;
  updateCode(id: string, patch: Partial<ShareCodeRow>): Promise<void>;
  /** Binds the code to its first reader, atomically. True if this reader holds it now. */
  redeemCode(id: string, hostPersonId: string, at: number, accessUntil: number): Promise<boolean>;
  addAccess(codeId: string, hostPersonId: string, at: number): Promise<void>;
  accessLog(codeId: string): Promise<number[]>;

  setLearning(gameId: string, slot: Slot, answer: "yes" | "no", at: number): Promise<void>;
  getLearning(gameId: string): Promise<Array<{ slot: Slot; answer: "yes" | "no" }>>;
  learningGames(): Promise<string[]>;
  deleteLearning(gameId: string, slot: Slot): Promise<void>;
  /** A seat takes back its yes (or says no late): the answer becomes "no", whatever it was. */
  withdrawLearning(gameId: string, slot: Slot, at: number): Promise<void>;

  addHostReport(r: HostReport): Promise<void>;
  listHostReports(): Promise<HostReport[]>;
  setHostReportStatus(id: string, status: HostReport["status"]): Promise<boolean>;

  addUnlink(r: UnlinkRequest): Promise<void>;
  listUnlinks(): Promise<UnlinkRequest[]>;
  getUnlink(id: string): Promise<UnlinkRequest | null>;
  markUnlinkDone(id: string, at: number): Promise<boolean>;

  /** The §10 retention schedule. Returns rows deleted (or cleared) per table. */
  purge(now: number, rules: PurgeRules): Promise<Record<string, number>>;
}

export interface PurgeRules {
  /** Acknowledgements: life of the event + this long. */
  ackAfterCloseMs: number;
  /** frozen_terms, the published funnel and the run's event link: this long after close. */
  eventRecordsAfterCloseMs: number;
  /** A share code's record and access log: this long after it stops being live. */
  codeAfterLiveMs: number;
  /** A done unlink request: this long after it was done. */
  unlinkDoneMs: number;
}

const clone = <T>(x: T): T => (x === null || x === undefined ? x : structuredClone(x));

const eventClosedAt = (e: HostEvent) => Math.min(e.closedAt ?? Infinity, e.closesAt);

export class InMemoryHostStore implements HostStore {
  people = new Map<string, HostPerson>();
  events = new Map<string, HostEvent>();
  cards = new Map<string, unknown>();
  acks = new Map<string, AckRow>();
  decisions = new Map<string, ShareDecision>();
  codes = new Map<string, ShareCodeRow>();
  access: Array<{ codeId: string; hostPersonId: string; openedAt: number }> = [];
  learning = new Map<string, { gameId: string; slot: Slot; answer: "yes" | "no"; at: number }>();
  reports = new Map<string, HostReport>();
  unlinks = new Map<string, UnlinkRequest>();

  async createPerson(p: HostPerson): Promise<boolean> {
    if ([...this.people.values()].some((x) => x.subject === p.subject)) return false;
    this.people.set(p.id, clone(p));
    return true;
  }
  async getPerson(id: string) { return clone(this.people.get(id) ?? null); }
  async personBySubject(subject: string) { return clone([...this.people.values()].find((p) => p.subject === subject) ?? null); }
  async listPeople() { return [...this.people.values()].map(clone).sort((a, b) => a.createdAt - b.createdAt); }
  async updatePerson(id: string, patch: Partial<HostPerson>) {
    const p = this.people.get(id);
    if (p) Object.assign(p, clone(patch));
  }

  async createEvent(e: HostEvent) {
    if (this.events.has(e.id) || [...this.events.values()].some((x) => x.codeHash === e.codeHash)) throw new Error("duplicate event");
    this.events.set(e.id, clone(e));
  }
  async getEvent(id: string) { return clone(this.events.get(id) ?? null); }
  async listEvents() { return [...this.events.values()].map(clone).sort((a, b) => a.createdAt - b.createdAt); }
  async updateEvent(id: string, patch: Partial<HostEvent>) {
    const e = this.events.get(id);
    if (!e) return null;
    Object.assign(e, clone(patch));
    return clone(e);
  }
  async freezeTerms(id: string, terms: FrozenTerms, at: number) {
    const e = this.events.get(id);
    if (!e || e.frozenTerms) return false;
    e.frozenTerms = clone(terms);
    e.firstAckAt = at;
    return true;
  }
  async publishFunnel(id: string, funnel: PublishedFunnel, at: number) {
    const e = this.events.get(id);
    if (!e || e.publishedFunnel) return false;
    e.publishedFunnel = clone(funnel);
    e.publishedAt = at;
    return true;
  }

  async saveCard(eventId: string, version: number, card: unknown) {
    const k = `${eventId}|${version}`;
    if (!this.cards.has(k)) this.cards.set(k, clone(card));
  }
  async getCard(eventId: string, version: number) { return clone(this.cards.get(`${eventId}|${version}`) ?? null); }

  async addAck(row: AckRow) { this.acks.set(row.id, clone(row)); }
  async ackByTokenHash(hash: string) { return clone([...this.acks.values()].find((a) => a.preTokenHash === hash) ?? null); }
  async bindAck(id: string, subject: string, at: number) {
    const a = this.acks.get(id);
    if (a && !a.subject) Object.assign(a, { subject, boundAt: at });
  }
  async acksForSubject(subject: string) { return [...this.acks.values()].filter((a) => a.subject === subject).map(clone); }
  async markQueued(subject: string, eventId: string, at: number) {
    for (const a of this.acks.values()) if (a.subject === subject && a.eventId === eventId && a.queuedAt === null) a.queuedAt = at;
  }
  async countQueued(eventId: string) {
    return new Set([...this.acks.values()].filter((a) => a.eventId === eventId && a.queuedAt !== null).map((a) => a.subject)).size;
  }
  async hasQueued(subject: string, eventId: string) {
    return [...this.acks.values()].some((a) => a.eventId === eventId && a.subject === subject && a.queuedAt !== null);
  }
  async unlistAcks(subject: string, eventId: string, at: number) {
    for (const a of this.acks.values()) if (a.subject === subject && a.eventId === eventId && a.unlistedAt === null) a.unlistedAt = at;
  }
  async deleteAcks(subject: string, eventId: string) {
    for (const [k, a] of this.acks) if (a.subject === subject && a.eventId === eventId) this.acks.delete(k);
  }

  async getDecisions(gameId: string) { return [...this.decisions.values()].filter((d) => d.gameId === gameId).map(clone); }
  async setDecision(row: ShareDecision) { this.decisions.set(`${row.gameId}|${row.slot}`, clone(row)); }
  async deleteDecisions(gameId: string, slot?: Slot) {
    for (const [k, d] of this.decisions) if (d.gameId === gameId && (!slot || d.slot === slot)) this.decisions.delete(k);
  }

  async insertCode(row: ShareCodeRow) {
    if ([...this.codes.values()].some((c) => c.gameId === row.gameId || c.codeHash === row.codeHash)) return false;
    this.codes.set(row.id, clone(row));
    return true;
  }
  async getCode(id: string) { return clone(this.codes.get(id) ?? null); }
  async codeByGame(gameId: string) { return clone([...this.codes.values()].find((c) => c.gameId === gameId) ?? null); }
  async codeByHash(hash: string) { return clone([...this.codes.values()].find((c) => c.codeHash === hash) ?? null); }
  async codesForReader(hostPersonId: string) { return clone([...this.codes.values()].filter((c) => c.redeemedBy === hostPersonId)); }
  async updateCode(id: string, patch: Partial<ShareCodeRow>) {
    const c = this.codes.get(id);
    if (c) Object.assign(c, clone(patch));
  }
  async redeemCode(id: string, hostPersonId: string, at: number, accessUntil: number) {
    const c = this.codes.get(id);
    if (!c) return false;
    if (c.redeemedBy === null) Object.assign(c, { redeemedBy: hostPersonId, redeemedAt: at, accessUntil });
    return c.redeemedBy === hostPersonId;
  }
  async addAccess(codeId: string, hostPersonId: string, at: number) { this.access.push({ codeId, hostPersonId, openedAt: at }); }
  async accessLog(codeId: string) { return this.access.filter((a) => a.codeId === codeId).map((a) => a.openedAt).sort((a, b) => a - b); }

  async setLearning(gameId: string, slot: Slot, answer: "yes" | "no", at: number) {
    const k = `${gameId}|${slot}`;
    if (!this.learning.has(k)) this.learning.set(k, { gameId, slot, answer, at });
  }
  async getLearning(gameId: string) {
    return [...this.learning.values()].filter((l) => l.gameId === gameId).map(({ slot, answer }) => ({ slot, answer }));
  }
  async learningGames() { return [...new Set([...this.learning.values()].map((l) => l.gameId))]; }
  async deleteLearning(gameId: string, slot: Slot) { this.learning.delete(`${gameId}|${slot}`); }
  async withdrawLearning(gameId: string, slot: Slot, at: number) { this.learning.set(`${gameId}|${slot}`, { gameId, slot, answer: "no", at }); }

  async addHostReport(r: HostReport) { this.reports.set(r.id, clone(r)); }
  async listHostReports() { return [...this.reports.values()].map(clone).sort((a, b) => a.at - b.at); }
  async setHostReportStatus(id: string, status: HostReport["status"]) {
    const r = this.reports.get(id);
    if (!r) return false;
    r.status = status;
    return true;
  }

  async addUnlink(r: UnlinkRequest) { this.unlinks.set(r.id, clone(r)); }
  async listUnlinks() { return [...this.unlinks.values()].map(clone).sort((a, b) => a.at - b.at); }
  async getUnlink(id: string) { return clone(this.unlinks.get(id) ?? null); }
  async markUnlinkDone(id: string, at: number) {
    const u = this.unlinks.get(id);
    if (!u || u.doneAt !== null) return false;
    u.doneAt = at;
    return true;
  }

  async purge(now: number, rules: PurgeRules) {
    const out: Record<string, number> = { host_event_acks: 0, share_decisions: 0, share_codes: 0, share_snapshots_cleared: 0, host_events_records_cleared: 0, unlink_requests: 0 };
    for (const [k, a] of this.acks) {
      const e = this.events.get(a.eventId);
      if (e && eventClosedAt(e) + rules.ackAfterCloseMs <= now) { this.acks.delete(k); out.host_event_acks++; }
    }
    for (const [k, d] of this.decisions) if (d.windowEndsAt <= now) { this.decisions.delete(k); out.share_decisions++; }
    for (const [k, c] of this.codes) {
      const end = codeLiveUntil(c);
      if (end + rules.codeAfterLiveMs <= now) {
        this.codes.delete(k);
        this.access = this.access.filter((a) => a.codeId !== c.id);
        out.share_codes++;
      } else if (end <= now && (c.snapshot.reportCard !== null || c.snapshot.epilogue !== null)) {
        c.snapshot = { reportCard: null, epilogue: null, reportCardOmitted: c.snapshot.reportCardOmitted };
        out.share_snapshots_cleared++;
      }
    }
    for (const e of this.events.values()) {
      if (eventClosedAt(e) + rules.eventRecordsAfterCloseMs <= now && (e.frozenTerms || e.publishedFunnel)) {
        e.frozenTerms = null;
        e.publishedFunnel = null;
        out.host_events_records_cleared++;
      }
    }
    for (const [k, u] of this.unlinks) if (u.doneAt !== null && u.doneAt + rules.unlinkDoneMs <= now) { this.unlinks.delete(k); out.unlink_requests++; }
    return out;
  }
}

/** When a code stops being live: stopped, or its redemption window or access ran out. */
export function codeLiveUntil(c: Pick<ShareCodeRow, "stoppedAt" | "expiresAt" | "accessUntil" | "redeemedBy">): number {
  const natural = c.redeemedBy ? (c.accessUntil ?? c.expiresAt) : c.expiresAt;
  return Math.min(natural, c.stoppedAt ?? Infinity);
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toPerson(r: Record<string, unknown>): HostPerson {
  return {
    id: String(r.id), subject: String(r.subject), displayName: String(r.display_name),
    roleText: (r.role_text as string | null) ?? null, roleChecked: (r.role_checked as string | null) ?? null, roleCheckedAt: n(r.role_checked_at),
    agreementVersion: String(r.agreement_version), agreementAt: Number(r.agreement_at),
    status: r.status as HostPerson["status"], createdAt: Number(r.created_at),
    hostType: (r.host_type as HostPerson["hostType"]) ?? null, organisation: (r.organisation as string | null) ?? null,
  };
}

const EVENT_COLS: Array<[keyof HostEvent, string]> = [
  ["id", "id"], ["codeHash", "code_hash"], ["source", "source"], ["name", "name"], ["kind", "kind"],
  ["hostPersonId", "host_person_id"], ["guestReaderId", "guest_reader_id"], ["promoterIds", "promoter_ids"], ["codeSeq", "code_seq"], ["sensitive", "sensitive"], ["authority", "authority"],
  ["eventsBusiness", "events_business"], ["level", "level"], ["shareCodes", "share_codes"], ["studioLearning", "studio_learning"],
  ["handleExchange", "handle_exchange"], ["welcomeText", "welcome_text"], ["lengthText", "length_text"], ["conductUrl", "conduct_url"],
  ["capacity", "capacity"], ["joinWindowMs", "join_window_ms"], ["opensAt", "opens_at"], ["closesAt", "closes_at"], ["paused", "paused"], ["pausedBy", "paused_by"],
  ["closedAt", "closed_at"], ["cardVersion", "card_version"], ["frozenTerms", "frozen_terms"], ["firstAckAt", "first_ack_at"],
  ["publishedFunnel", "published_funnel"], ["publishedAt", "published_at"], ["createdAt", "created_at"],
];
const NUMERIC_EVENT = new Set<keyof HostEvent>(["level", "codeSeq", "capacity", "joinWindowMs", "opensAt", "closesAt", "closedAt", "cardVersion", "firstAckAt", "publishedAt", "createdAt"]);
const JSON_EVENT = new Set<keyof HostEvent>(["frozenTerms", "publishedFunnel"]);

function toEvent(r: Record<string, unknown>): HostEvent {
  const e: Record<string, unknown> = {};
  for (const [k, c] of EVENT_COLS) e[k] = NUMERIC_EVENT.has(k) ? n(r[c]) : (r[c] ?? null);
  if (!Array.isArray(e.promoterIds)) e.promoterIds = [];
  return e as unknown as HostEvent;
}

function toAck(r: Record<string, unknown>): AckRow {
  return {
    id: String(r.id), eventId: String(r.event_id), cardVersion: Number(r.card_version), preTokenHash: String(r.pre_token_hash),
    subject: (r.subject as string | null) ?? null, at: Number(r.at), boundAt: n(r.bound_at), queuedAt: n(r.queued_at), unlistedAt: n(r.unlisted_at),
  };
}

function toCode(r: Record<string, unknown>): ShareCodeRow {
  return {
    id: String(r.id), gameId: String(r.game_id), eventId: String(r.event_id), codeHash: String(r.code_hash),
    snapshot: r.snapshot as ShareCodeRow["snapshot"], visibleAt: Number(r.visible_at), expiresAt: Number(r.expires_at),
    redeemedBy: (r.redeemed_by as string | null) ?? null, redeemedAt: n(r.redeemed_at), accessUntil: n(r.access_until),
    stoppedAt: n(r.stopped_at), stoppedBy: (r.stopped_by as Slot | null) ?? null,
  };
}

const CODE_COLS: Array<[keyof ShareCodeRow, string]> = [
  ["snapshot", "snapshot"], ["visibleAt", "visible_at"], ["expiresAt", "expires_at"], ["redeemedBy", "redeemed_by"],
  ["redeemedAt", "redeemed_at"], ["accessUntil", "access_until"], ["stoppedAt", "stopped_at"], ["stoppedBy", "stopped_by"],
];

export class PgHostStore implements HostStore {
  constructor(private readonly db: Pick<Pool, "query">) {}

  async createPerson(p: HostPerson) {
    const r = await this.db.query(
      `INSERT INTO host_people (id, subject, display_name, role_text, role_checked, role_checked_at, agreement_version, agreement_at, status, created_at, host_type, organisation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (subject) DO NOTHING RETURNING id`,
      [p.id, p.subject, p.displayName, p.roleText, p.roleChecked, p.roleCheckedAt, p.agreementVersion, p.agreementAt, p.status, p.createdAt, p.hostType, p.organisation],
    );
    return r.rows.length > 0;
  }
  async getPerson(id: string) {
    const r = await this.db.query(`SELECT * FROM host_people WHERE id = $1`, [id]);
    return r.rows[0] ? toPerson(r.rows[0]) : null;
  }
  async personBySubject(subject: string) {
    const r = await this.db.query(`SELECT * FROM host_people WHERE subject = $1`, [subject]);
    return r.rows[0] ? toPerson(r.rows[0]) : null;
  }
  async listPeople() {
    return (await this.db.query(`SELECT * FROM host_people ORDER BY created_at`)).rows.map(toPerson);
  }
  async updatePerson(id: string, patch: Partial<HostPerson>) {
    const map: Array<[keyof HostPerson, string]> = [["status", "status"], ["displayName", "display_name"], ["roleText", "role_text"], ["roleChecked", "role_checked"], ["roleCheckedAt", "role_checked_at"], ["hostType", "host_type"], ["organisation", "organisation"]];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, c] of map) if (k in patch) { vals.push(patch[k]); sets.push(`${c} = $${vals.length}`); }
    if (!sets.length) return;
    vals.push(id);
    await this.db.query(`UPDATE host_people SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  }

  async createEvent(e: HostEvent) {
    const cols = EVENT_COLS.map(([, c]) => c);
    const vals = EVENT_COLS.map(([k]) => (JSON_EVENT.has(k) ? (e[k] === null ? null : JSON.stringify(e[k])) : e[k]));
    await this.db.query(`INSERT INTO host_events (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  }
  async getEvent(id: string) {
    const r = await this.db.query(`SELECT * FROM host_events WHERE id = $1`, [id]);
    return r.rows[0] ? toEvent(r.rows[0]) : null;
  }
  async listEvents() {
    return (await this.db.query(`SELECT * FROM host_events ORDER BY created_at`)).rows.map(toEvent);
  }
  async updateEvent(id: string, patch: Partial<HostEvent>) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, c] of EVENT_COLS) {
      if (k === "id" || !(k in patch)) continue;
      vals.push(JSON_EVENT.has(k) ? (patch[k] === null ? null : JSON.stringify(patch[k])) : patch[k]);
      sets.push(`${c} = $${vals.length}`);
    }
    if (sets.length) {
      vals.push(id);
      await this.db.query(`UPDATE host_events SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    }
    return this.getEvent(id);
  }
  async freezeTerms(id: string, terms: FrozenTerms, at: number) {
    const r = await this.db.query(
      `UPDATE host_events SET frozen_terms = $2, first_ack_at = $3 WHERE id = $1 AND frozen_terms IS NULL RETURNING id`,
      [id, JSON.stringify(terms), at],
    );
    return r.rows.length > 0;
  }
  async publishFunnel(id: string, funnel: PublishedFunnel, at: number) {
    const r = await this.db.query(
      `UPDATE host_events SET published_funnel = $2, published_at = $3 WHERE id = $1 AND published_funnel IS NULL RETURNING id`,
      [id, JSON.stringify(funnel), at],
    );
    return r.rows.length > 0;
  }

  async saveCard(eventId: string, version: number, card: unknown) {
    await this.db.query(
      `INSERT INTO host_event_cards (event_id, card_version, card) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [eventId, version, JSON.stringify(card)],
    );
  }
  async getCard(eventId: string, version: number) {
    const r = await this.db.query(`SELECT card FROM host_event_cards WHERE event_id = $1 AND card_version = $2`, [eventId, version]);
    return r.rows[0]?.card ?? null;
  }

  async addAck(a: AckRow) {
    await this.db.query(
      `INSERT INTO host_event_acks (id, event_id, card_version, pre_token_hash, subject, at, bound_at, queued_at, unlisted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.id, a.eventId, a.cardVersion, a.preTokenHash, a.subject, a.at, a.boundAt, a.queuedAt, a.unlistedAt],
    );
  }
  async ackByTokenHash(hash: string) {
    const r = await this.db.query(`SELECT * FROM host_event_acks WHERE pre_token_hash = $1`, [hash]);
    return r.rows[0] ? toAck(r.rows[0]) : null;
  }
  async bindAck(id: string, subject: string, at: number) {
    await this.db.query(`UPDATE host_event_acks SET subject = $2, bound_at = $3 WHERE id = $1 AND subject IS NULL`, [id, subject, at]);
  }
  async acksForSubject(subject: string) {
    return (await this.db.query(`SELECT * FROM host_event_acks WHERE subject = $1 ORDER BY at`, [subject])).rows.map(toAck);
  }
  async markQueued(subject: string, eventId: string, at: number) {
    await this.db.query(`UPDATE host_event_acks SET queued_at = $3 WHERE subject = $1 AND event_id = $2 AND queued_at IS NULL`, [subject, eventId, at]);
  }
  async countQueued(eventId: string) {
    const r = await this.db.query(`SELECT count(DISTINCT subject)::int AS n FROM host_event_acks WHERE event_id = $1 AND queued_at IS NOT NULL`, [eventId]);
    return Number(r.rows[0]?.n ?? 0);
  }
  async hasQueued(subject: string, eventId: string) {
    const r = await this.db.query(`SELECT 1 FROM host_event_acks WHERE subject = $1 AND event_id = $2 AND queued_at IS NOT NULL LIMIT 1`, [subject, eventId]);
    return r.rows.length > 0;
  }
  async unlistAcks(subject: string, eventId: string, at: number) {
    await this.db.query(`UPDATE host_event_acks SET unlisted_at = $3 WHERE subject = $1 AND event_id = $2 AND unlisted_at IS NULL`, [subject, eventId, at]);
  }
  async deleteAcks(subject: string, eventId: string) {
    await this.db.query(`DELETE FROM host_event_acks WHERE subject = $1 AND event_id = $2`, [subject, eventId]);
  }

  async getDecisions(gameId: string) {
    const r = await this.db.query(`SELECT * FROM share_decisions WHERE game_id = $1`, [gameId]);
    return r.rows.map((x) => ({ gameId: x.game_id, slot: x.slot, answer: x.answer, at: Number(x.at), windowEndsAt: Number(x.window_ends_at) }));
  }
  async setDecision(d: ShareDecision) {
    await this.db.query(
      `INSERT INTO share_decisions (game_id, slot, answer, at, window_ends_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (game_id, slot) DO UPDATE SET answer = EXCLUDED.answer, at = EXCLUDED.at`,
      [d.gameId, d.slot, d.answer, d.at, d.windowEndsAt],
    );
  }
  async deleteDecisions(gameId: string, slot?: Slot) {
    if (slot) await this.db.query(`DELETE FROM share_decisions WHERE game_id = $1 AND slot = $2`, [gameId, slot]);
    else await this.db.query(`DELETE FROM share_decisions WHERE game_id = $1`, [gameId]);
  }

  async insertCode(c: ShareCodeRow) {
    const r = await this.db.query(
      `INSERT INTO share_codes (id, game_id, event_id, code_hash, snapshot, visible_at, expires_at, redeemed_by, redeemed_at, access_until, stopped_at, stopped_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
      [c.id, c.gameId, c.eventId, c.codeHash, JSON.stringify(c.snapshot), c.visibleAt, c.expiresAt, c.redeemedBy, c.redeemedAt, c.accessUntil, c.stoppedAt, c.stoppedBy],
    );
    return r.rows.length > 0;
  }
  async getCode(id: string) {
    const r = await this.db.query(`SELECT * FROM share_codes WHERE id = $1`, [id]);
    return r.rows[0] ? toCode(r.rows[0]) : null;
  }
  async codeByGame(gameId: string) {
    const r = await this.db.query(`SELECT * FROM share_codes WHERE game_id = $1`, [gameId]);
    return r.rows[0] ? toCode(r.rows[0]) : null;
  }
  async codeByHash(hash: string) {
    const r = await this.db.query(`SELECT * FROM share_codes WHERE code_hash = $1`, [hash]);
    return r.rows[0] ? toCode(r.rows[0]) : null;
  }
  async codesForReader(hostPersonId: string) {
    return (await this.db.query(`SELECT * FROM share_codes WHERE redeemed_by = $1`, [hostPersonId])).rows.map(toCode);
  }
  async updateCode(id: string, patch: Partial<ShareCodeRow>) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, c] of CODE_COLS) {
      if (!(k in patch)) continue;
      vals.push(k === "snapshot" ? JSON.stringify(patch[k]) : patch[k]);
      sets.push(`${c} = $${vals.length}`);
    }
    if (!sets.length) return;
    vals.push(id);
    await this.db.query(`UPDATE share_codes SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  }
  async redeemCode(id: string, hostPersonId: string, at: number, accessUntil: number) {
    await this.db.query(
      `UPDATE share_codes SET redeemed_by = $2, redeemed_at = $3, access_until = $4 WHERE id = $1 AND redeemed_by IS NULL`,
      [id, hostPersonId, at, accessUntil],
    );
    const r = await this.db.query(`SELECT redeemed_by FROM share_codes WHERE id = $1`, [id]);
    return r.rows[0]?.redeemed_by === hostPersonId;
  }
  async addAccess(codeId: string, hostPersonId: string, at: number) {
    await this.db.query(`INSERT INTO share_access_log (code_id, host_person_id, opened_at) VALUES ($1, $2, $3)`, [codeId, hostPersonId, at]);
  }
  async accessLog(codeId: string) {
    return (await this.db.query(`SELECT opened_at FROM share_access_log WHERE code_id = $1 ORDER BY opened_at`, [codeId])).rows.map((r) => Number(r.opened_at));
  }

  async setLearning(gameId: string, slot: Slot, answer: "yes" | "no", at: number) {
    await this.db.query(
      `INSERT INTO studio_learning_choices (game_id, slot, answer, at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [gameId, slot, answer, at],
    );
  }
  async getLearning(gameId: string) {
    return (await this.db.query(`SELECT slot, answer FROM studio_learning_choices WHERE game_id = $1`, [gameId])).rows as Array<{ slot: Slot; answer: "yes" | "no" }>;
  }
  async learningGames() {
    return (await this.db.query(`SELECT DISTINCT game_id FROM studio_learning_choices`)).rows.map((r) => String(r.game_id));
  }
  async deleteLearning(gameId: string, slot: Slot) {
    await this.db.query(`DELETE FROM studio_learning_choices WHERE game_id = $1 AND slot = $2`, [gameId, slot]);
  }
  async withdrawLearning(gameId: string, slot: Slot, at: number) {
    await this.db.query(
      `INSERT INTO studio_learning_choices (game_id, slot, answer, at) VALUES ($1,$2,'no',$3)
       ON CONFLICT (game_id, slot) DO UPDATE SET answer = 'no', at = EXCLUDED.at`,
      [gameId, slot, at],
    );
  }

  async addHostReport(r: HostReport) {
    await this.db.query(`INSERT INTO host_reports (id, event_id, text, at, status) VALUES ($1,$2,$3,$4,$5)`, [r.id, r.eventId, r.text, r.at, r.status]);
  }
  async listHostReports() {
    return (await this.db.query(`SELECT * FROM host_reports ORDER BY at`)).rows.map((r) => ({
      id: String(r.id), eventId: (r.event_id as string | null) ?? null, text: String(r.text), at: Number(r.at), status: r.status as HostReport["status"],
    }));
  }
  async setHostReportStatus(id: string, status: HostReport["status"]) {
    return (await this.db.query(`UPDATE host_reports SET status = $2 WHERE id = $1 RETURNING id`, [id, status])).rows.length > 0;
  }

  async addUnlink(u: UnlinkRequest) {
    await this.db.query(`INSERT INTO unlink_requests (id, game_id, subject, at, done_at) VALUES ($1,$2,$3,$4,$5)`, [u.id, u.gameId, u.subject, u.at, u.doneAt]);
  }
  private toUnlink(r: Record<string, unknown>): UnlinkRequest {
    return { id: String(r.id), gameId: String(r.game_id), subject: String(r.subject), at: Number(r.at), doneAt: n(r.done_at) };
  }
  async listUnlinks() {
    return (await this.db.query(`SELECT * FROM unlink_requests ORDER BY at`)).rows.map((r) => this.toUnlink(r));
  }
  async getUnlink(id: string) {
    const r = await this.db.query(`SELECT * FROM unlink_requests WHERE id = $1`, [id]);
    return r.rows[0] ? this.toUnlink(r.rows[0]) : null;
  }
  async markUnlinkDone(id: string, at: number) {
    return (await this.db.query(`UPDATE unlink_requests SET done_at = $2 WHERE id = $1 AND done_at IS NULL RETURNING id`, [id, at])).rows.length > 0;
  }

  async purge(now: number, rules: PurgeRules) {
    const closed = `LEAST(COALESCE(e.closed_at, e.closes_at), e.closes_at)`;
    const count = (r: { rowCount: number | null }) => r.rowCount ?? 0;
    const acks = await this.db.query(
      `DELETE FROM host_event_acks a USING host_events e WHERE a.event_id = e.id AND ${closed} + $2 <= $1`,
      [now, rules.ackAfterCloseMs],
    );
    const decisions = await this.db.query(`DELETE FROM share_decisions WHERE window_ends_at <= $1`, [now]);
    const codes = await this.db.query(`DELETE FROM share_codes WHERE ${liveUntilSql()} + $2 <= $1`, [now, rules.codeAfterLiveMs]);
    const snaps = await this.db.query(
      `UPDATE share_codes SET snapshot = jsonb_build_object('reportCard', NULL, 'epilogue', NULL, 'reportCardOmitted', snapshot->'reportCardOmitted')
       WHERE ${liveUntilSql()} <= $1 AND (snapshot->>'reportCard' IS NOT NULL OR snapshot->>'epilogue' IS NOT NULL)`,
      [now],
    );
    const events = await this.db.query(
      `UPDATE host_events e SET frozen_terms = NULL, published_funnel = NULL
       WHERE ${closed} + $2 <= $1 AND (frozen_terms IS NOT NULL OR published_funnel IS NOT NULL)`,
      [now, rules.eventRecordsAfterCloseMs],
    );
    const unlinks = await this.db.query(`DELETE FROM unlink_requests WHERE done_at IS NOT NULL AND done_at + $2 <= $1`, [now, rules.unlinkDoneMs]);
    return {
      host_event_acks: count(acks), share_decisions: count(decisions), share_codes: count(codes),
      share_snapshots_cleared: count(snaps), host_events_records_cleared: count(events), unlink_requests: count(unlinks),
    };
  }
}

/** codeLiveUntil, in SQL. */
function liveUntilSql(): string {
  return `LEAST(CASE WHEN redeemed_by IS NULL THEN expires_at ELSE COALESCE(access_until, expires_at) END, COALESCE(stopped_at, 9223372036854775807))`;
}
