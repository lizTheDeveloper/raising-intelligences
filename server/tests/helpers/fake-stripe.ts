import type { CheckoutApi, CheckoutSession, Refund, StripeParams } from "../../src/payments/stripe.js";
import { StripeError } from "../../src/payments/stripe.js";
import type { PaymentConfig } from "../../src/payments/config.js";

/**
 * An in-memory Stripe Checkout that behaves like the real one where RI's
 * correctness depends on it: idempotency keys replay the original object, a
 * session can only be paid once, refunds are idempotent per key.
 */
export class FakeCheckout implements CheckoutApi {
  sessions = new Map<string, CheckoutSession>();
  private byKey = new Map<string, string>();
  refunds: Array<{ id: string; paymentIntent: string; key: string; reason: string }> = [];
  private refundByKey = new Map<string, Refund>();
  createCalls = 0;
  expireCalls: string[] = [];
  private n = 0;
  now = () => Date.now();

  async createCheckoutSession(params: StripeParams, idempotencyKey: string): Promise<CheckoutSession> {
    this.createCalls++;
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return { ...this.sessions.get(existing)! };
    const id = `cs_test_fake${String(++this.n).padStart(12, "0")}`;
    const session: CheckoutSession = {
      id,
      object: "checkout.session",
      url: `https://checkout.stripe.test/pay/${id}`,
      status: "open",
      payment_status: "unpaid",
      amount_total: Number(params["line_items[0][price_data][unit_amount]"]),
      currency: String(params["line_items[0][price_data][currency]"]),
      mode: String(params.mode) as CheckoutSession["mode"],
      metadata: {
        ri_purpose: String(params["metadata[ri_purpose]"]),
        ri_game_id: String(params["metadata[ri_game_id]"]),
      },
      client_reference_id: String(params.client_reference_id),
      payment_intent: null,
      livemode: false,
      expires_at: Number(params.expires_at),
    };
    this.sessions.set(id, session);
    this.byKey.set(idempotencyKey, id);
    return { ...session };
  }

  async retrieveCheckoutSession(id: string): Promise<CheckoutSession> {
    const s = this.sessions.get(id);
    if (!s) throw new StripeError("No such checkout.session", 404);
    return { ...s };
  }

  async expireCheckoutSession(id: string): Promise<void> {
    this.expireCalls.push(id);
    const s = this.sessions.get(id);
    if (s && s.status === "open") s.status = "expired";
  }

  async createRefund(paymentIntent: string, key: string, reason: string): Promise<Refund> {
    const existing = this.refundByKey.get(key);
    if (existing) return existing;
    const refund = { id: `re_fake_${this.refunds.length + 1}`, status: "succeeded" };
    this.refunds.push({ id: refund.id, paymentIntent, key, reason });
    this.refundByKey.set(key, refund);
    return refund;
  }

  /** The player completes Checkout. Returns the completed session. */
  pay(id: string): CheckoutSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    if (s.status !== "open") throw new Error(`session ${id} is ${s.status}`);
    s.status = "complete";
    s.payment_status = "paid";
    s.payment_intent = `pi_fake_${id.slice(-6)}`;
    return { ...s };
  }

  /** Force a session's clock forward (as if it expired). */
  expireNow(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      s.status = "expired";
      s.expires_at = Math.floor(this.now() / 1000) - 1;
    }
  }
}

export const WEBHOOK_SECRET = "whsec_test_fake_secret";

export function paywallConfig(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return {
    switchOn: true,
    secretKey: "sk_test_fake",
    webhookSecret: WEBHOOK_SECRET,
    livePaymentsAllowed: false,
    publicBaseUrl: "http://localhost:5173",
    ...overrides,
  };
}

export function checkoutCompletedEvent(session: CheckoutSession, id = `evt_${session.id}`): string {
  return JSON.stringify({ id, type: "checkout.session.completed", data: { object: session } });
}
