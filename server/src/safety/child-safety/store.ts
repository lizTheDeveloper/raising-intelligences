import type pg from "pg";

/**
 * Storage for the child-safety evidence vault (schema `child_safety`, see
 * migration 025). Deliberately separate from the game tables:
 *
 * - no foreign key to `games` — a case must outlive the game, the player's
 *   research deletion (deleteGameData), and any IP unban;
 * - the evidence payload is stored only as ciphertext (see crypto.ts);
 * - every write that changes a case also writes an access-log row in the same
 *   transaction, and vault.ts writes a log row before any decrypt.
 *
 * This layer stores rows and nothing else. Policy (who may read, retention,
 * what a dismissal does) lives in vault.ts.
 */

export type CaseStatus = "open" | "dismissed" | "confirmed" | "reported" | "released";

export interface Identifier {
  /** "ip" | "matrix" | "account" | "email" | ... — what the value is. */
  kind: string;
  value: string;
  /**
   * "flagged": belongs to the sender whose content was flagged — banned on
   * confirm and listed in the report package. "participant": seen in the same
   * game from another seat (co-player) or from no known seat — never banned or
   * reported unless a reviewer explicitly includes it, with a reason.
   * Absent on rows written before roles existed; see identifierRole().
   */
  role?: "flagged" | "participant";
  /**
   * True only for identifiers the server itself observed or authenticated
   * (a request IP, a campus identity from a verified launch pass). Client-
   * claimed IDs (RI's Matrix userId) are false: kept as "claimed, unverified",
   * never banned or reported.
   */
  verified?: boolean;
  /** Seat that produced it (parent1 / parent2), when known. */
  slot?: string | null;
  /** Set when a reviewer moved a participant into the flagged set. */
  includedBy?: string;
  includedReason?: string;
}

/** Role of an identifier; legacy role-less rows count as flagged only for the case's own request IP. */
export function identifierRole(id: Identifier, caseIp: string | null): "flagged" | "participant" {
  if (id.role) return id.role;
  return id.kind === "ip" && id.value === caseIp ? "flagged" : "participant";
}

/** Whether an identifier is verified; legacy rows: IPs (server-observed) yes, anything else no. */
export function identifierVerified(id: Identifier): boolean {
  return id.verified ?? id.kind === "ip";
}

export interface CaseRow {
  id: string;
  /** Where the flag came from: ri_message, ri_scene, ri_legacy_flag, whispers, tsb, breach, llm_proxy, synthetic_test. */
  source: string;
  status: CaseStatus;
  categories: string[];
  /** Game / session id in the source system. Text, never a foreign key. */
  gameRef: string | null;
  ipAddress: string | null;
  /** Identifiers a confirmed case bans (IP, Matrix ID, ...). Kept in clear so a ban can be applied. */
  identifiers: Identifier[];
  incidentAt: number;
  createdAt: number;
  contentSha256: string;
  keyId: string;
  ciphertext: string;
  /** Idempotency key: a legacy moderation_flags id, or a caller-supplied id from another service. */
  externalRef: string | null;
  /** Related cases from the same sending service share this (migration 026). */
  groupRef?: string | null;
  /** 'flag' (default) or 'suppressed_burst': a structured over-the-cap counter (migration 026). */
  recordKind?: "flag" | "suppressed_burst" | null;
  isTest: boolean;
  locked: boolean;
  retainUntil: number | null;
  purgeAfter: number | null;
  dismissedAt: number | null;
  dismissedBy: string | null;
  dismissReason: string | null;
  confirmedAt: number | null;
  confirmedBy: string | null;
  reportedAt: number | null;
  reportedBy: string | null;
  cybertipReportId: string | null;
}

export interface AccessEntry {
  caseId: string | null;
  actor: string;
  /** create | list | view | export | dismiss | confirm | reported | release | purge | delete_test | ban */
  action: string;
  actorIp: string | null;
  detail: string | null;
  at: number;
}

export interface IpLogEntry {
  ip: string;
  gameRef: string | null;
  /** game_create | socket_create | socket_join | message */
  event: string;
  /** parent1 / parent2 when the seat is known. */
  slot: string | null;
  userAgent: string | null;
  /**
   * Account id seen for this seat: a client-claimed Matrix userId (unverified),
   * or a campus identity the server verified itself (accountVerified).
   */
  accountId: string | null;
  /**
   * True only when the server verified accountId (a campus launch pass traded
   * at /api/campus-pass). Rows written before migration 027 read false.
   */
  accountVerified: boolean;
  /**
   * Who within the seat produced the row (migration 027): "seat:<token hash>",
   * "id:<campus id hash>", "rest", or null on older rows. See preserveEvidence.
   */
  occupant: string | null;
  at: number;
}

export interface ChildSafetyStore {
  /** Inserts the case and its "create" access row in one transaction. */
  insertCase(row: CaseRow, access: AccessEntry): Promise<void>;
  getCase(id: string): Promise<CaseRow | null>;
  findByExternalRef(ref: string): Promise<string | null>;
  listCases(filter: { statuses?: CaseStatus[]; limit: number; offset: number }): Promise<{ cases: CaseRow[]; total: number }>;
  /** Applies the patch and writes the access row in one transaction. */
  updateCase(id: string, patch: Partial<CaseRow>, access: AccessEntry): Promise<void>;
  appendAccess(entry: AccessEntry): Promise<void>;
  listAccess(caseId: string): Promise<AccessEntry[]>;
  /** Hard delete with an access row. vault.ts only calls this for synthetic test cases. */
  deleteCase(id: string, access: AccessEntry): Promise<void>;
  insertIpLog(entry: IpLogEntry): Promise<void>;
  ipLogForGame(gameRef: string, sinceMs: number): Promise<IpLogEntry[]>;
  /**
   * Deletes unlocked cases in status dismissed/released whose purge_after has
   * passed (writing a "purge" access row for each, which is kept), and IP-log
   * rows older than ipLogCutoffMs. Open, confirmed and reported cases are
   * never touched, whatever their dates.
   */
  purge(nowMs: number, ipLogCutoffMs: number): Promise<{ purgedCaseIds: string[]; ipRowsDeleted: number }>;
  banIdentifier(id: Identifier, reason: string, caseId: string | null): Promise<void>;
  isIdentifierBanned(id: Identifier): Promise<boolean>;
}

const PURGEABLE: CaseStatus[] = ["dismissed", "released"];

// ── In-memory (tests and DATABASE_URL-less dev) ─────────────────────────────

export class InMemoryChildSafetyStore implements ChildSafetyStore {
  cases = new Map<string, CaseRow>();
  access: AccessEntry[] = [];
  ipLog: IpLogEntry[] = [];
  bans = new Map<string, { reason: string; caseId: string | null }>();

  async insertCase(row: CaseRow, access: AccessEntry): Promise<void> {
    if (row.externalRef && [...this.cases.values()].some((c) => c.externalRef === row.externalRef)) {
      // Same shape as Postgres's unique violation, so callers handle both alike.
      throw Object.assign(new Error("evidence_cases: duplicate external_ref"), { code: "23505" });
    }
    this.cases.set(row.id, { ...row });
    this.access.push({ ...access });
  }
  async getCase(id: string): Promise<CaseRow | null> {
    const c = this.cases.get(id);
    return c ? { ...c } : null;
  }
  async findByExternalRef(ref: string): Promise<string | null> {
    return [...this.cases.values()].find((c) => c.externalRef === ref)?.id ?? null;
  }
  async listCases(filter: { statuses?: CaseStatus[]; limit: number; offset: number }) {
    const all = [...this.cases.values()]
      .filter((c) => !filter.statuses || filter.statuses.includes(c.status))
      .sort((a, b) => b.createdAt - a.createdAt);
    return { cases: all.slice(filter.offset, filter.offset + filter.limit).map((c) => ({ ...c })), total: all.length };
  }
  async updateCase(id: string, patch: Partial<CaseRow>, access: AccessEntry): Promise<void> {
    const c = this.cases.get(id);
    if (!c) throw new Error("case not found");
    this.cases.set(id, { ...c, ...patch, id });
    this.access.push({ ...access });
  }
  async appendAccess(entry: AccessEntry): Promise<void> {
    this.access.push({ ...entry });
  }
  async listAccess(caseId: string): Promise<AccessEntry[]> {
    return this.access.filter((a) => a.caseId === caseId).map((a) => ({ ...a }));
  }
  async deleteCase(id: string, access: AccessEntry): Promise<void> {
    this.cases.delete(id);
    this.access.push({ ...access });
  }
  async insertIpLog(entry: IpLogEntry): Promise<void> {
    this.ipLog.push({ ...entry });
  }
  async ipLogForGame(gameRef: string, sinceMs: number): Promise<IpLogEntry[]> {
    return this.ipLog.filter((e) => e.gameRef === gameRef && e.at >= sinceMs).map((e) => ({ ...e }));
  }
  async purge(nowMs: number, ipLogCutoffMs: number) {
    const purgedCaseIds: string[] = [];
    for (const c of [...this.cases.values()]) {
      if (!c.locked && PURGEABLE.includes(c.status) && c.purgeAfter !== null && c.purgeAfter <= nowMs) {
        this.cases.delete(c.id);
        this.access.push({ caseId: c.id, actor: "system", action: "purge", actorIp: null, detail: c.status, at: nowMs });
        purgedCaseIds.push(c.id);
      }
    }
    const before = this.ipLog.length;
    this.ipLog = this.ipLog.filter((e) => e.at >= ipLogCutoffMs);
    return { purgedCaseIds, ipRowsDeleted: before - this.ipLog.length };
  }
  async banIdentifier(id: Identifier, reason: string, caseId: string | null): Promise<void> {
    this.bans.set(`${id.kind}:${id.value}`, { reason, caseId });
  }
  async isIdentifierBanned(id: Identifier): Promise<boolean> {
    return this.bans.has(`${id.kind}:${id.value}`);
  }
}

// ── Postgres ────────────────────────────────────────────────────────────────

type Db = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

const COLS: Array<[keyof CaseRow, string]> = [
  ["id", "id"],
  ["source", "source"],
  ["status", "status"],
  ["categories", "categories"],
  ["gameRef", "game_ref"],
  ["ipAddress", "ip_address"],
  ["identifiers", "identifiers"],
  ["incidentAt", "incident_at"],
  ["createdAt", "created_at"],
  ["contentSha256", "content_sha256"],
  ["keyId", "key_id"],
  ["ciphertext", "ciphertext"],
  ["externalRef", "external_ref"],
  ["groupRef", "group_ref"],
  ["recordKind", "record_kind"],
  ["isTest", "is_test"],
  ["locked", "locked"],
  ["retainUntil", "retain_until"],
  ["purgeAfter", "purge_after"],
  ["dismissedAt", "dismissed_at"],
  ["dismissedBy", "dismissed_by"],
  ["dismissReason", "dismiss_reason"],
  ["confirmedAt", "confirmed_at"],
  ["confirmedBy", "confirmed_by"],
  ["reportedAt", "reported_at"],
  ["reportedBy", "reported_by"],
  ["cybertipReportId", "cybertip_report_id"],
];
const TIME_FIELDS = new Set<keyof CaseRow>([
  "incidentAt", "createdAt", "retainUntil", "purgeAfter", "dismissedAt", "confirmedAt", "reportedAt",
]);

function toDb(field: keyof CaseRow, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (TIME_FIELDS.has(field)) return new Date(v as number);
  if (field === "identifiers") return JSON.stringify(v);
  return v;
}

function fromDb(r: Record<string, unknown>): CaseRow {
  const out: Record<string, unknown> = {};
  for (const [field, col] of COLS) {
    const v = r[col];
    if (TIME_FIELDS.has(field)) out[field] = v === null || v === undefined ? null : new Date(v as string).getTime();
    else out[field] = v ?? null;
  }
  out.categories = (r.categories as string[] | null) ?? [];
  out.identifiers = (r.identifiers as Identifier[] | null) ?? [];
  return out as unknown as CaseRow;
}

function accessParams(a: AccessEntry): unknown[] {
  return [a.caseId, a.actor, a.action, a.actorIp, a.detail, new Date(a.at)];
}
const ACCESS_INSERT =
  `INSERT INTO child_safety.access_log (case_id, actor, action, actor_ip, detail, at) VALUES ($1, $2, $3, $4, $5, $6)`;

export class PgChildSafetyStore implements ChildSafetyStore {
  constructor(private db: Db) {}

  private async tx<T>(fn: (c: Pick<pg.PoolClient, "query">) => Promise<T>): Promise<T> {
    if (!this.db.connect) throw new Error("child-safety store needs a pool with connect()");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async insertCase(row: CaseRow, access: AccessEntry): Promise<void> {
    const cols = COLS.map(([, c]) => c);
    const vals = COLS.map(([f]) => toDb(f, row[f]));
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO child_safety.evidence_cases (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
        vals,
      );
      await c.query(ACCESS_INSERT, accessParams(access));
    });
  }

  async getCase(id: string): Promise<CaseRow | null> {
    const { rows } = await this.db.query(`SELECT * FROM child_safety.evidence_cases WHERE id = $1`, [id]);
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async findByExternalRef(ref: string): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM child_safety.evidence_cases WHERE external_ref = $1`, [ref]);
    return rows[0]?.id ?? null;
  }

  async listCases(filter: { statuses?: CaseStatus[]; limit: number; offset: number }) {
    const where = filter.statuses ? `WHERE status = ANY($3)` : "";
    const params: unknown[] = [filter.limit, filter.offset];
    if (filter.statuses) params.push(filter.statuses);
    const { rows } = await this.db.query(
      `SELECT *, count(*) OVER () AS total FROM child_safety.evidence_cases ${where}
        ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params,
    );
    let total = Number(rows[0]?.total ?? 0);
    if (rows.length === 0 && filter.offset > 0) {
      const countParams = filter.statuses ? [filter.statuses] : [];
      const { rows: c } = await this.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM child_safety.evidence_cases ${filter.statuses ? "WHERE status = ANY($1)" : ""}`,
        countParams,
      );
      total = Number(c[0]?.n ?? 0);
    }
    return { cases: rows.map(fromDb), total };
  }

  async updateCase(id: string, patch: Partial<CaseRow>, access: AccessEntry): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [field, col] of COLS) {
      if (field === "id" || !(field in patch)) continue;
      vals.push(toDb(field, patch[field]));
      sets.push(`${col} = $${vals.length}`);
    }
    vals.push(id);
    await this.tx(async (c) => {
      if (sets.length > 0) {
        const r = await c.query(`UPDATE child_safety.evidence_cases SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
        if (r.rowCount === 0) throw new Error("case not found");
      }
      await c.query(ACCESS_INSERT, accessParams(access));
    });
  }

  async appendAccess(entry: AccessEntry): Promise<void> {
    await this.db.query(ACCESS_INSERT, accessParams(entry));
  }

  async listAccess(caseId: string): Promise<AccessEntry[]> {
    const { rows } = await this.db.query(
      `SELECT case_id, actor, action, actor_ip, detail, at FROM child_safety.access_log WHERE case_id = $1 ORDER BY at, id`,
      [caseId],
    );
    return rows.map((r) => ({
      caseId: r.case_id, actor: r.actor, action: r.action, actorIp: r.actor_ip, detail: r.detail,
      at: new Date(r.at).getTime(),
    }));
  }

  async deleteCase(id: string, access: AccessEntry): Promise<void> {
    await this.tx(async (c) => {
      await c.query(`DELETE FROM child_safety.evidence_cases WHERE id = $1`, [id]);
      await c.query(ACCESS_INSERT, accessParams(access));
    });
  }

  async insertIpLog(e: IpLogEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO child_safety.ip_log (ip, game_ref, event, slot, user_agent, account_id, account_verified, occupant, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.ip, e.gameRef, e.event, e.slot, e.userAgent, e.accountId, e.accountVerified === true, e.occupant ?? null, new Date(e.at)],
    );
  }

  async ipLogForGame(gameRef: string, sinceMs: number): Promise<IpLogEntry[]> {
    const { rows } = await this.db.query(
      `SELECT ip, game_ref, event, slot, user_agent, account_id, account_verified, occupant, at FROM child_safety.ip_log
        WHERE game_ref = $1 AND at >= $2 ORDER BY at`,
      [gameRef, new Date(sinceMs)],
    );
    return rows.map((r) => ({
      ip: r.ip, gameRef: r.game_ref, event: r.event, slot: r.slot ?? null, userAgent: r.user_agent, accountId: r.account_id,
      accountVerified: r.account_verified === true, occupant: r.occupant ?? null, at: new Date(r.at).getTime(),
    }));
  }

  async purge(nowMs: number, ipLogCutoffMs: number) {
    return this.tx(async (c) => {
      const { rows } = await c.query<{ id: string; status: string }>(
        `DELETE FROM child_safety.evidence_cases
          WHERE locked = false AND status = ANY($1) AND purge_after IS NOT NULL AND purge_after <= $2
          RETURNING id, status`,
        [PURGEABLE, new Date(nowMs)],
      );
      for (const r of rows) {
        await c.query(ACCESS_INSERT, [r.id, "system", "purge", null, r.status, new Date(nowMs)]);
      }
      const ip = await c.query(`DELETE FROM child_safety.ip_log WHERE at < $1`, [new Date(ipLogCutoffMs)]);
      return { purgedCaseIds: rows.map((r) => r.id), ipRowsDeleted: ip.rowCount ?? 0 };
    });
  }

  async banIdentifier(id: Identifier, reason: string, caseId: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO child_safety.banned_identifiers (kind, value, reason, case_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, value) DO UPDATE SET reason = EXCLUDED.reason, case_id = COALESCE(EXCLUDED.case_id, child_safety.banned_identifiers.case_id)`,
      [id.kind, id.value, reason, caseId],
    );
  }

  async isIdentifierBanned(id: Identifier): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM child_safety.banned_identifiers WHERE kind = $1 AND value = $2`, [id.kind, id.value]);
    return rows.length > 0;
  }
}
