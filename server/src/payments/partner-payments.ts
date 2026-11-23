import { logger } from "../logger.js";
import {
  PARTNER_CHILD_CURRENCY,
  PARTNER_CHILD_PRICE_CENTS,
  PARTNER_PURPOSE,
  keyMode,
  paywallState,
  readPaymentConfig,
  type PaymentConfig,
} from "./config.js";
import type { ChildPayment, PartnerPaymentStore } from "./store.js";
import {
  StripeError,
  createCheckoutApi,
  createStripeRest,
  verifyWebhookSignature,
  type CheckoutApi,
  type CheckoutSession,
} from "./stripe.js";

/**
 * The $20 per-child partner payment.
 *
 * The rules (spec, "Pricing and who pays"):
 * - The host is the `parent1` seat, in every mode. Only `parent1` is asked to pay.
 * - A child becomes `due` only when its opening is complete with two humans
 *   (`openingAllowed`). Nothing is generated for it until it is `paid`.
 * - One charge per child. Repeated "pay" clicks reuse the open Checkout
 *   Session; a second session that gets paid anyway is refunded automatically;
 *   a webhook event is processed at most once; the due → paid write is atomic
 *   in the store.
 */

export interface PaymentView {
  status: "due" | "paid" | "refunded";
  /** True only on the host's (parent1's) own view. */
  youPay: boolean;
  amountCents: number;
}

export type ApplyOutcome = "paid" | "already_paid" | "duplicate_refunded" | "ignored";

export interface PartnerPaymentsOptions {
  store: PartnerPaymentStore;
  /** Defaults to reading the environment on every call. */
  config?: () => PaymentConfig;
  /** Injected in tests; built from the configured key otherwise. */
  checkout?: CheckoutApi;
  now?: () => number;
}

/** Minimum life left on an open session before it is reused rather than replaced. */
const REUSE_MIN_REMAINING_MS = 5 * 60 * 1000;
/** Checkout Sessions last an hour (Stripe allows 30 minutes to 24 hours). */
const SESSION_LIFETIME_S = 60 * 60;

export class PartnerPayments {
  private readonly store: PartnerPaymentStore;
  private readonly config: () => PaymentConfig;
  private readonly injectedCheckout?: CheckoutApi;
  private builtCheckout: { key: string; api: CheckoutApi } | null = null;
  private readonly now: () => number;
  /** Per-game snapshot so STATE (which is synchronous) can show the payment step. */
  private readonly cache = new Map<string, ChildPayment | null>();
  private readonly paidListeners: Array<(gameId: string) => void> = [];

  constructor(opts: PartnerPaymentsOptions) {
    this.store = opts.store;
    this.config = opts.config ?? (() => readPaymentConfig());
    this.injectedCheckout = opts.checkout;
    this.now = opts.now ?? Date.now;
  }

  /** Is the paywall charging right now? False means partner play is free. */
  active(): boolean {
    return paywallState(this.config()) === "active";
  }

  private checkoutApi(): CheckoutApi | null {
    if (this.injectedCheckout) return this.injectedCheckout;
    const cfg = this.config();
    const key = cfg.secretKey;
    if (!key || keyMode(key) === "invalid") return null;
    // A live key is never used without the explicit second switch — not even
    // for a refund. Refunds of live charges are done from the Stripe dashboard
    // until Liz sets RI_STRIPE_LIVE_PAYMENTS=true.
    if (keyMode(key) === "live" && !cfg.livePaymentsAllowed) return null;
    if (this.builtCheckout?.key !== key) {
      this.builtCheckout = { key, api: createCheckoutApi(createStripeRest(key)) };
    }
    return this.builtCheckout.api;
  }

  /** Registered by the socket layer: start the opening once a child is paid. */
  onPaid(listener: (gameId: string) => void): void {
    this.paidListeners.push(listener);
  }

  /** Load a game's payment row into the snapshot (on join / rehydration). */
  async hydrate(gameId: string): Promise<void> {
    if (!this.active() && !this.cache.has(gameId)) return;
    try {
      this.cache.set(gameId, await this.store.get(gameId));
    } catch (err) {
      // A join must never fail on this: the gate itself re-reads the store.
      logger.error("partner_payment_hydrate_failed", { gameId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Slot-specific payment view for STATE; null when there is nothing to show. */
  view(gameId: string, slot: string): PaymentView | null {
    const row = this.cache.get(gameId);
    if (!row) return null;
    if (row.status === "due" && !this.active()) return null;
    return { status: row.status, youPay: slot === "parent1", amountCents: row.amountCents };
  }

  /**
   * The opening gate. Called (with the game lock held) once both parents'
   * answers are in. Returns true when the seed and scene 1 may be generated.
   *
   * `twoHumans` is the "the partner has joined" half of the rule: false for
   * solo play and for a child raised with the AI co-parent, which are free.
   */
  async openingAllowed(gameId: string, twoHumans: boolean): Promise<boolean> {
    if (!twoHumans) return true;
    // Switch off (or no usable key): partner play is free and this is the old
    // flow exactly — not even a database read that could fail.
    if (!this.active()) return true;
    const existing = await this.store.get(gameId);
    this.cache.set(gameId, existing);
    if (existing && existing.status !== "due") return true;
    if (!existing) {
      const due = await this.store.markDue(gameId, PARTNER_CHILD_PRICE_CENTS, PARTNER_CHILD_CURRENCY);
      this.cache.set(gameId, due);
      logger.info("partner_payment_due", { gameId });
      return due.status !== "due";
    }
    return false;
  }

  /** True when a game owes the $20 and must not be advanced by any other path. */
  async owes(gameId: string): Promise<boolean> {
    const row = await this.store.get(gameId);
    if (row) return row.status === "due" && this.active();
    return false;
  }

  /**
   * The host's Checkout URL. Caller holds the game lock (so two clicks can't
   * both decide to create a session) and has checked the host's token.
   */
  async checkoutUrl(gameId: string): Promise<{ url: string } | { error: string; status: number; alreadyPaid?: boolean }> {
    if (!this.active()) return { error: "Partner play is free right now.", status: 409 };
    const api = this.checkoutApi();
    if (!api) return { error: "Payments are not configured.", status: 503 };
    const row = await this.store.get(gameId);
    this.cache.set(gameId, row);
    if (!row) return { error: "Nothing is due for this child yet.", status: 409 };
    if (row.status !== "due") return { error: "This child is already paid for.", status: 409, alreadyPaid: true };

    const now = this.now();
    const sessions = await this.store.listSessions(gameId);
    // Only a session made with the current key's mode: after a switch from
    // test to live keys, a stored test session must never be handed out.
    const modePrefix = keyMode(this.config().secretKey) === "live" ? "cs_live_" : "cs_test_";
    const reusable = sessions.find(
      (s) => s.status === "open" && s.sessionId.startsWith(modePrefix) && s.expiresAt - now > REUSE_MIN_REMAINING_MS,
    );
    if (reusable) return { url: reusable.url };

    // Keyed on how many sessions this child has had, so a retried request
    // after a crash between Stripe's reply and our insert gets the SAME
    // session back from Stripe instead of a second one.
    let attempt = sessions.length + 1;
    for (let tries = 0; tries < 3; tries++, attempt++) {
      let created: CheckoutSession;
      try {
        created = await api.createCheckoutSession(this.sessionParams(gameId, now), `ri-checkout-${gameId}-${attempt}`);
      } catch (err) {
        // The key was used before with other parameters (a crash after Stripe
        // made a session but before we recorded it, then a retry with a new
        // expiry). That orphan is still settled if paid — applySession adopts
        // any session carrying our metadata — so move on to the next key.
        if (err instanceof StripeError && err.code === "idempotency_error") continue;
        throw err;
      }
      const expiresAt = created.expires_at * 1000;
      const usable = created.status === "open" && !!created.url && expiresAt - now > REUSE_MIN_REMAINING_MS;
      await this.store.addSession({
        sessionId: created.id,
        gameId,
        url: created.url ?? "",
        expiresAt,
        status: usable ? "open" : created.payment_status === "paid" ? "paid" : "expired",
        paymentIntentId: created.payment_intent ?? null,
        refundId: null,
        createdAt: now,
      });
      if (usable) {
        logger.info("partner_checkout_created", { gameId, attempt });
        return { url: created.url! };
      }
      // An idempotent replay of a session that has since expired (or was paid
      // and is waiting on its webhook): if it was paid, settle it now.
      if (created.payment_status === "paid") {
        const outcome = await this.applySession(created, "checkout_replay");
        if (outcome === "paid" || outcome === "already_paid") {
          return { error: "This child is already paid for.", status: 409, alreadyPaid: true };
        }
      }
    }
    return { error: "Could not start checkout. Try again.", status: 502 };
  }

  private sessionParams(gameId: string, now: number) {
    const base = this.config().publicBaseUrl;
    const game = encodeURIComponent(gameId);
    return {
      mode: "payment",
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": PARTNER_CHILD_CURRENCY,
      "line_items[0][price_data][unit_amount]": PARTNER_CHILD_PRICE_CENTS,
      // Generic wording on purpose: no player-typed text (the child's name)
      // goes to Stripe.
      "line_items[0][price_data][product_data][name]": "Raising Intelligences: raise one child with a partner",
      client_reference_id: gameId,
      "metadata[ri_purpose]": PARTNER_PURPOSE,
      "metadata[ri_game_id]": gameId,
      "payment_intent_data[metadata][ri_purpose]": PARTNER_PURPOSE,
      "payment_intent_data[metadata][ri_game_id]": gameId,
      success_url: `${base}/?game=${game}&partner_paid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?game=${game}`,
      expires_at: Math.floor(now / 1000) + SESSION_LIFETIME_S,
    };
  }

  /**
   * Settle a Checkout Session Stripe says is paid. Every path that learns of a
   * payment — the webhook, the player's return, an idempotent replay — comes
   * through here.
   */
  async applySession(session: CheckoutSession, source: string): Promise<ApplyOutcome> {
    const gameId = session.metadata?.ri_game_id;
    if (session.metadata?.ri_purpose !== PARTNER_PURPOSE || !gameId) return "ignored";
    if (session.mode !== "payment" || session.payment_status !== "paid") return "ignored";
    if (session.amount_total !== PARTNER_CHILD_PRICE_CENTS || session.currency !== PARTNER_CHILD_CURRENCY) {
      logger.error("partner_payment_amount_mismatch", { gameId, sessionId: session.id, amount: session.amount_total, currency: session.currency });
      return "ignored";
    }
    // The session must be in the mode of the key we charge with: a test-mode
    // payment never settles a child while live keys are in use, or vice versa.
    if (session.livemode !== (keyMode(this.config().secretKey) === "live")) {
      logger.error("partner_payment_mode_mismatch", { gameId, sessionId: session.id, livemode: session.livemode });
      return "ignored";
    }
    // Only Stripe tells us about a session here (a signed webhook, or a
    // retrieve by id), and only this service sets ri_purpose/ri_game_id on a
    // session, so one we have no row for is still ours: a session created
    // just before a crash. Adopt it rather than keep the host's money and
    // leave the child due.
    let known = (await this.store.listSessions(gameId)).find((s) => s.sessionId === session.id);
    if (!known) {
      logger.warn("partner_payment_adopted_session", { gameId, sessionId: session.id, source });
      known = {
        sessionId: session.id,
        gameId,
        url: "",
        expiresAt: (session.expires_at ?? 0) * 1000,
        status: "open",
        paymentIntentId: session.payment_intent ?? null,
        refundId: null,
        createdAt: this.now(),
      };
      await this.store.addSession(known);
    }

    const pi = session.payment_intent ?? null;
    const { transitioned, row } = await this.store.markPaid(gameId, session.id, pi, session.livemode);
    if (transitioned) {
      this.cache.set(gameId, row);
      logger.info("partner_payment_paid", { gameId, source, livemode: session.livemode });
      // Bookkeeping only: the child is paid either way, and the opening must
      // not wait on it (a failure here used to skip the listeners for good).
      try {
        await this.store.updateSession(session.id, { status: "paid", paymentIntentId: pi ?? undefined });
        await this.expireOtherSessions(gameId, session.id);
      } catch (err) {
        logger.error("partner_payment_bookkeeping_failed", { gameId, error: err instanceof Error ? err.message : String(err) });
      }
      for (const listener of this.paidListeners) {
        try {
          listener(gameId);
        } catch (err) {
          logger.error("partner_payment_listener_error", { gameId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return "paid";
    }
    if (row && row.paidSessionId === session.id) return "already_paid";

    // Paid twice for one child (or paid with no due row at all). Give the
    // second payment back. The idempotency key makes a retry of this — a
    // webhook redelivery, the player's return racing the webhook — one refund.
    if (known.status === "duplicate_refunded") return "duplicate_refunded";
    if (!pi) {
      logger.error("partner_payment_duplicate_without_intent", { gameId, sessionId: session.id });
      return "ignored";
    }
    const api = this.checkoutApi();
    if (!api) {
      logger.error("partner_payment_duplicate_unrefunded", { gameId, sessionId: session.id, reason: "no usable key" });
      throw new Error("duplicate payment could not be refunded: no usable Stripe key");
    }
    const refund = await api.createRefund(pi, `ri-dup-refund-${session.id}`, "duplicate", {
      ri_game_id: gameId,
      ri_reason: "duplicate_partner_payment",
    });
    await this.store.updateSession(session.id, { status: "duplicate_refunded", paymentIntentId: pi, refundId: refund.id });
    logger.warn("partner_payment_duplicate_refunded", { gameId, sessionId: session.id, source });
    return "duplicate_refunded";
  }

  private async expireOtherSessions(gameId: string, paidSessionId: string): Promise<void> {
    const api = this.checkoutApi();
    const now = this.now();
    for (const s of await this.store.listSessions(gameId)) {
      if (s.sessionId === paidSessionId || s.status !== "open") continue;
      await this.store.updateSession(s.sessionId, { status: "expired" });
      if (!api || s.expiresAt <= now) continue;
      // Best effort: if this fails and the session is paid anyway, applySession
      // refunds it.
      await api.expireCheckoutSession(s.sessionId).catch((err) => {
        logger.warn("partner_checkout_expire_failed", { gameId, error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  /** The player's return from Checkout. The session is read from Stripe, never trusted from the client. */
  async confirm(gameId: string, sessionId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const api = this.checkoutApi();
    if (!api) return { status: 503, body: { error: "Payments are not configured." } };
    let session: CheckoutSession;
    try {
      session = await api.retrieveCheckoutSession(sessionId);
    } catch (err) {
      if (err instanceof StripeError && err.status === 404) return { status: 404, body: { error: "Unknown checkout session." } };
      throw err;
    }
    if (session.metadata?.ri_game_id !== gameId) return { status: 404, body: { error: "Unknown checkout session." } };
    const outcome = await this.applySession(session, "return");
    const row = await this.store.get(gameId);
    this.cache.set(gameId, row);
    return { status: 200, body: { outcome, status: row?.status ?? null } };
  }

  /**
   * A signed Stripe webhook. Returns the HTTP answer. Processing is idempotent
   * on its own; the event-id record just skips repeat work, and is written
   * only after success so a failure is retried by Stripe.
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    const secret = this.config().webhookSecret;
    if (!secret) return { status: 503, body: { error: "webhook not configured" } };
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      logger.warn("stripe_webhook_bad_signature");
      return { status: 400, body: { error: "bad signature" } };
    }
    let event: { id?: string; type?: string; data?: { object?: unknown } };
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "bad payload" } };
    }
    if (!event.id || !event.type) return { status: 400, body: { error: "bad payload" } };
    if (await this.store.hasEvent(event.id)) return { status: 200, body: { received: true, duplicate: true } };

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      await this.applySession(event.data?.object as CheckoutSession, `webhook:${event.type}`);
    } else {
      for (const handler of this.extraHandlers) await handler(event.type, event.data?.object);
    }
    await this.store.recordEvent(event.id, event.type);
    return { status: 200, body: { received: true } };
  }

  private readonly extraHandlers: Array<(type: string, object: unknown) => Promise<void>> = [];
  /** Other features (Stripe Identity) receive the same signed webhook. */
  addWebhookHandler(handler: (type: string, object: unknown) => Promise<void>): void {
    this.extraHandlers.push(handler);
  }

  /** Admin refund of a paid child. The child keeps playing. */
  async adminRefund(gameId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const row = await this.store.get(gameId);
    if (!row || row.status === "due") return { status: 404, body: { error: "No payment for this child." } };
    if (row.status === "refunded") return { status: 200, body: { refunded: true, refundId: row.refundId } };
    const api = this.checkoutApi();
    if (!api) return { status: 503, body: { error: "Payments are not configured." } };
    if (!row.paymentIntentId) return { status: 409, body: { error: "No payment intent recorded; refund it from the Stripe dashboard." } };
    const refund = await api.createRefund(row.paymentIntentId, `ri-admin-refund-${row.paymentIntentId}`, "requested_by_customer", {
      ri_game_id: gameId,
      ri_reason: "admin_refund",
    });
    await this.store.markRefunded(gameId, refund.id);
    this.cache.set(gameId, await this.store.get(gameId));
    logger.info("partner_payment_admin_refund", { gameId });
    return { status: 200, body: { refunded: true, refundId: refund.id } };
  }
}
