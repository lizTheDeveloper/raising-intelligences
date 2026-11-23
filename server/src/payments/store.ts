import type pg from "pg";

/**
 * Storage for the $20 per-child partner payment (migration 028).
 *
 * One `partner_payments` row per child, created only when the child becomes
 * `due` (two humans, opening complete). The due → paid transition is a single
 * conditional UPDATE, so two processes, a webhook and a player's return, or a
 * replayed event can never both "win" it — that conditional write is the
 * bottom of the double-charge defence; everything above it is courtesy.
 *
 * No foreign key to `games`: a payment is a financial record and outlives a
 * deleted game.
 */

export type ChildPaymentStatus = "due" | "paid" | "refunded";

export interface ChildPayment {
  gameId: string;
  status: ChildPaymentStatus;
  amountCents: number;
  currency: string;
  /** ms since epoch */
  dueAt: number;
  paidAt: number | null;
  paidSessionId: string | null;
  paymentIntentId: string | null;
  livemode: boolean | null;
  refundId: string | null;
  refundedAt: number | null;
}

export type PaymentSessionStatus = "open" | "paid" | "expired" | "duplicate_refunded";

export interface PaymentSessionRow {
  sessionId: string;
  gameId: string;
  url: string;
  /** ms since epoch */
  expiresAt: number;
  status: PaymentSessionStatus;
  paymentIntentId: string | null;
  refundId: string | null;
  createdAt: number;
}

export interface PartnerPaymentStore {
  get(gameId: string): Promise<ChildPayment | null>;
  /** Insert a `due` row if the child has none; returns whatever row exists. */
  markDue(gameId: string, amountCents: number, currency: string): Promise<ChildPayment>;
  /** Atomic due → paid. `transitioned` is true only for the one call that made it. */
  markPaid(
    gameId: string,
    sessionId: string,
    paymentIntentId: string | null,
    livemode: boolean
  ): Promise<{ transitioned: boolean; row: ChildPayment | null }>;
  markRefunded(gameId: string, refundId: string): Promise<void>;
  addSession(row: PaymentSessionRow): Promise<void>;
  listSessions(gameId: string): Promise<PaymentSessionRow[]>;
  updateSession(sessionId: string, patch: Partial<Pick<PaymentSessionRow, "status" | "paymentIntentId" | "refundId">>): Promise<void>;
  hasEvent(eventId: string): Promise<boolean>;
  recordEvent(eventId: string, type: string): Promise<void>;
}

export class InMemoryPartnerPaymentStore implements PartnerPaymentStore {
  private payments = new Map<string, ChildPayment>();
  private sessions = new Map<string, PaymentSessionRow>();
  private events = new Set<string>();

  async get(gameId: string): Promise<ChildPayment | null> {
    const p = this.payments.get(gameId);
    return p ? { ...p } : null;
  }

  async markDue(gameId: string, amountCents: number, currency: string): Promise<ChildPayment> {
    let p = this.payments.get(gameId);
    if (!p) {
      p = {
        gameId, status: "due", amountCents, currency, dueAt: Date.now(), paidAt: null,
        paidSessionId: null, paymentIntentId: null, livemode: null, refundId: null, refundedAt: null,
      };
      this.payments.set(gameId, p);
    }
    return { ...p };
  }

  async markPaid(gameId: string, sessionId: string, paymentIntentId: string | null, livemode: boolean) {
    const p = this.payments.get(gameId);
    if (!p) return { transitioned: false, row: null };
    if (p.status !== "due") return { transitioned: false, row: { ...p } };
    Object.assign(p, { status: "paid", paidAt: Date.now(), paidSessionId: sessionId, paymentIntentId, livemode });
    return { transitioned: true, row: { ...p } };
  }

  async markRefunded(gameId: string, refundId: string): Promise<void> {
    const p = this.payments.get(gameId);
    if (p && p.status === "paid") Object.assign(p, { status: "refunded", refundId, refundedAt: Date.now() });
  }

  async addSession(row: PaymentSessionRow): Promise<void> {
    if (!this.sessions.has(row.sessionId)) this.sessions.set(row.sessionId, { ...row });
  }

  async listSessions(gameId: string): Promise<PaymentSessionRow[]> {
    return [...this.sessions.values()].filter((s) => s.gameId === gameId).map((s) => ({ ...s }));
  }

  async updateSession(sessionId: string, patch: Partial<Pick<PaymentSessionRow, "status" | "paymentIntentId" | "refundId">>) {
    const s = this.sessions.get(sessionId);
    if (s) Object.assign(s, patch);
  }

  async hasEvent(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }

  async recordEvent(eventId: string): Promise<void> {
    this.events.add(eventId);
  }
}

type Db = Pick<pg.Pool, "query">;

interface PaymentDbRow {
  game_id: string;
  status: ChildPaymentStatus;
  amount_cents: number;
  currency: string;
  due_at: Date;
  paid_at: Date | null;
  paid_session_id: string | null;
  payment_intent_id: string | null;
  livemode: boolean | null;
  refund_id: string | null;
  refunded_at: Date | null;
}

function toPayment(r: PaymentDbRow): ChildPayment {
  return {
    gameId: r.game_id,
    status: r.status,
    amountCents: r.amount_cents,
    currency: r.currency,
    dueAt: new Date(r.due_at).getTime(),
    paidAt: r.paid_at ? new Date(r.paid_at).getTime() : null,
    paidSessionId: r.paid_session_id,
    paymentIntentId: r.payment_intent_id,
    livemode: r.livemode,
    refundId: r.refund_id,
    refundedAt: r.refunded_at ? new Date(r.refunded_at).getTime() : null,
  };
}

interface SessionDbRow {
  session_id: string;
  game_id: string;
  url: string;
  expires_at: Date;
  status: PaymentSessionStatus;
  payment_intent_id: string | null;
  refund_id: string | null;
  created_at: Date;
}

function toSession(r: SessionDbRow): PaymentSessionRow {
  return {
    sessionId: r.session_id,
    gameId: r.game_id,
    url: r.url,
    expiresAt: new Date(r.expires_at).getTime(),
    status: r.status,
    paymentIntentId: r.payment_intent_id,
    refundId: r.refund_id,
    createdAt: new Date(r.created_at).getTime(),
  };
}

export class PgPartnerPaymentStore implements PartnerPaymentStore {
  constructor(private db: Db) {}

  async get(gameId: string): Promise<ChildPayment | null> {
    const { rows } = await this.db.query<PaymentDbRow>("SELECT * FROM partner_payments WHERE game_id = $1", [gameId]);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async markDue(gameId: string, amountCents: number, currency: string): Promise<ChildPayment> {
    await this.db.query(
      `INSERT INTO partner_payments (game_id, status, amount_cents, currency)
       VALUES ($1, 'due', $2, $3) ON CONFLICT (game_id) DO NOTHING`,
      [gameId, amountCents, currency]
    );
    return (await this.get(gameId))!;
  }

  async markPaid(gameId: string, sessionId: string, paymentIntentId: string | null, livemode: boolean) {
    const { rows } = await this.db.query<PaymentDbRow>(
      `UPDATE partner_payments
          SET status = 'paid', paid_at = now(), paid_session_id = $2, payment_intent_id = $3, livemode = $4, updated_at = now()
        WHERE game_id = $1 AND status = 'due'
      RETURNING *`,
      [gameId, sessionId, paymentIntentId, livemode]
    );
    if (rows[0]) return { transitioned: true, row: toPayment(rows[0]) };
    return { transitioned: false, row: await this.get(gameId) };
  }

  async markRefunded(gameId: string, refundId: string): Promise<void> {
    await this.db.query(
      `UPDATE partner_payments SET status = 'refunded', refund_id = $2, refunded_at = now(), updated_at = now()
        WHERE game_id = $1 AND status = 'paid'`,
      [gameId, refundId]
    );
  }

  async addSession(row: PaymentSessionRow): Promise<void> {
    await this.db.query(
      `INSERT INTO partner_payment_sessions (session_id, game_id, url, expires_at, status, payment_intent_id, refund_id)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, $7) ON CONFLICT (session_id) DO NOTHING`,
      [row.sessionId, row.gameId, row.url, row.expiresAt, row.status, row.paymentIntentId, row.refundId]
    );
  }

  async listSessions(gameId: string): Promise<PaymentSessionRow[]> {
    const { rows } = await this.db.query<SessionDbRow>(
      "SELECT * FROM partner_payment_sessions WHERE game_id = $1 ORDER BY created_at",
      [gameId]
    );
    return rows.map(toSession);
  }

  async updateSession(sessionId: string, patch: Partial<Pick<PaymentSessionRow, "status" | "paymentIntentId" | "refundId">>) {
    await this.db.query(
      `UPDATE partner_payment_sessions
          SET status = COALESCE($2, status),
              payment_intent_id = COALESCE($3, payment_intent_id),
              refund_id = COALESCE($4, refund_id)
        WHERE session_id = $1`,
      [sessionId, patch.status ?? null, patch.paymentIntentId ?? null, patch.refundId ?? null]
    );
  }

  async hasEvent(eventId: string): Promise<boolean> {
    const { rows } = await this.db.query("SELECT 1 FROM stripe_events WHERE event_id = $1", [eventId]);
    return rows.length > 0;
  }

  async recordEvent(eventId: string, type: string): Promise<void> {
    await this.db.query(
      "INSERT INTO stripe_events (event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
      [eventId, type]
    );
  }
}
