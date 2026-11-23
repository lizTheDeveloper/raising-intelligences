import { describe, it, expect, beforeEach } from "vitest";
import { PartnerPayments } from "../src/payments/partner-payments.js";
import { InMemoryPartnerPaymentStore } from "../src/payments/store.js";
import { keyMode, paywallState, readPaymentConfig, type PaymentConfig } from "../src/payments/config.js";
import { signWebhookPayload, verifyWebhookSignature } from "../src/payments/stripe.js";
import { FakeCheckout, WEBHOOK_SECRET, checkoutCompletedEvent, paywallConfig } from "./helpers/fake-stripe.js";

const GAME = "11111111-2222-4333-8444-555555555555";

describe("Stripe webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature(body, signWebhookPayload(body, "whsec_x"), "whsec_x")).toBe(true);
  });

  it("rejects a tampered body, the wrong secret, a stale timestamp and garbage", () => {
    const header = signWebhookPayload(body, "whsec_x");
    expect(verifyWebhookSignature(body + " ", header, "whsec_x")).toBe(false);
    expect(verifyWebhookSignature(body, header, "whsec_y")).toBe(false);
    const old = signWebhookPayload(body, "whsec_x", Math.floor(Date.now() / 1000) - 3600);
    expect(verifyWebhookSignature(body, old, "whsec_x")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, "whsec_x")).toBe(false);
    expect(verifyWebhookSignature(body, "t=abc,v1=zz", "whsec_x")).toBe(false);
    expect(verifyWebhookSignature(body, "v1=deadbeef", "whsec_x")).toBe(false);
  });

  it("accepts when any one of several v1 signatures matches (secret rotation)", () => {
    const t = Math.floor(Date.now() / 1000);
    const good = signWebhookPayload(body, "whsec_x", t).split("v1=")[1];
    expect(verifyWebhookSignature(body, `t=${t},v1=${"0".repeat(64)},v1=${good}`, "whsec_x")).toBe(true);
  });
});

describe("Paywall switch and key safety", () => {
  it("is off unless RI_PARTNER_PAYWALL=on", () => {
    expect(paywallState(readPaymentConfig({ RI_STRIPE_SECRET_KEY: "sk_test_a" } as NodeJS.ProcessEnv))).toBe("off");
    expect(paywallState(readPaymentConfig({ RI_PARTNER_PAYWALL: "true", RI_STRIPE_SECRET_KEY: "sk_test_a" } as NodeJS.ProcessEnv))).toBe("off");
    expect(paywallState(readPaymentConfig({ RI_PARTNER_PAYWALL: "on", RI_STRIPE_SECRET_KEY: "sk_test_a" } as NodeJS.ProcessEnv))).toBe("active");
  });

  it("never charges with a live key unless RI_STRIPE_LIVE_PAYMENTS=true", () => {
    const env = { RI_PARTNER_PAYWALL: "on", RI_STRIPE_SECRET_KEY: "sk_live_abc" } as NodeJS.ProcessEnv;
    expect(paywallState(readPaymentConfig(env))).toBe("live_key_not_allowed");
    expect(paywallState(readPaymentConfig({ ...env, RI_STRIPE_LIVE_PAYMENTS: "true" }))).toBe("active");
    expect(keyMode("rk_live_x")).toBe("live");
    expect(keyMode("pk_test_x")).toBe("invalid");
  });

  it("stays free when switched on with no usable key", () => {
    expect(paywallState(readPaymentConfig({ RI_PARTNER_PAYWALL: "on" } as NodeJS.ProcessEnv))).toBe("no_key");
    expect(paywallState(readPaymentConfig({ RI_PARTNER_PAYWALL: "on", RI_STRIPE_SECRET_KEY: "pk_test_x" } as NodeJS.ProcessEnv))).toBe("invalid_key");
  });
});

describe("PartnerPayments", () => {
  let store: InMemoryPartnerPaymentStore;
  let stripe: FakeCheckout;
  let cfg: PaymentConfig;
  let payments: PartnerPayments;
  let paidCalls: string[];

  beforeEach(() => {
    store = new InMemoryPartnerPaymentStore();
    stripe = new FakeCheckout();
    cfg = paywallConfig();
    payments = new PartnerPayments({ store, config: () => cfg, checkout: stripe });
    paidCalls = [];
    payments.onPaid((g) => paidCalls.push(g));
  });

  async function dueChild(): Promise<void> {
    expect(await payments.openingAllowed(GAME, true)).toBe(false);
  }

  it("lets the opening through, with no row, when the paywall is off", async () => {
    cfg = paywallConfig({ switchOn: false });
    expect(await payments.openingAllowed(GAME, true)).toBe(true);
    expect(await store.get(GAME)).toBeNull();
  });

  it("never charges a solo or AI co-parent child", async () => {
    expect(await payments.openingAllowed(GAME, false)).toBe(true);
    expect(await store.get(GAME)).toBeNull();
  });

  it("marks a two-human child due and shows the step to the host only", async () => {
    await dueChild();
    expect((await store.get(GAME))?.status).toBe("due");
    expect(payments.view(GAME, "parent1")).toEqual({ status: "due", youPay: true, amountCents: 2000 });
    expect(payments.view(GAME, "parent2")).toEqual({ status: "due", youPay: false, amountCents: 2000 });
  });

  it("refuses a checkout before the partner has joined", async () => {
    const r = await payments.checkoutUrl(GAME);
    expect("url" in r).toBe(false);
    expect(stripe.createCalls).toBe(0);
  });

  it("reuses the open session on a second click", async () => {
    await dueChild();
    const a = await payments.checkoutUrl(GAME);
    const b = await payments.checkoutUrl(GAME);
    expect(a).toEqual(b);
    expect(stripe.sessions.size).toBe(1);
    const s = [...stripe.sessions.values()][0];
    expect(s.amount_total).toBe(2000);
    expect(s.currency).toBe("usd");
    expect(s.metadata?.ri_game_id).toBe(GAME);
  });

  it("creates a fresh session once the old one has expired", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const first = [...stripe.sessions.keys()][0];
    stripe.expireNow(first);
    await store.updateSession(first, { status: "expired" });
    const r = await payments.checkoutUrl(GAME);
    expect("url" in r && r.url).toContain("cs_test_fake000000000002");
  });

  it("settles a paid session once, however many times it is reported", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const id = [...stripe.sessions.keys()][0];
    const paid = stripe.pay(id);
    expect(await payments.applySession(paid, "webhook")).toBe("paid");
    expect(await payments.applySession(paid, "return")).toBe("already_paid");
    expect(await payments.applySession(paid, "webhook")).toBe("already_paid");
    expect(paidCalls).toEqual([GAME]);
    expect(stripe.refunds).toHaveLength(0);
    expect((await store.get(GAME))?.status).toBe("paid");
    expect(payments.view(GAME, "parent1")?.status).toBe("paid");
  });

  it("refunds a second paid session for the same child, exactly once", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const first = [...stripe.sessions.keys()][0];
    // A second tab opened after the first session expired locally.
    await store.updateSession(first, { status: "expired" });
    await payments.checkoutUrl(GAME);
    const second = [...stripe.sessions.keys()][1];
    // Both are paid (Stripe let the first one complete before expiring).
    stripe.sessions.get(first)!.status = "open";
    const a = stripe.pay(first);
    const b = stripe.pay(second);
    expect(await payments.applySession(a, "webhook")).toBe("paid");
    expect(await payments.applySession(b, "webhook")).toBe("duplicate_refunded");
    expect(await payments.applySession(b, "return")).toBe("duplicate_refunded");
    expect(stripe.refunds).toHaveLength(1);
    expect(stripe.refunds[0].paymentIntent).toBe(b.payment_intent);
    expect(paidCalls).toHaveLength(1);
  });

  it("refunds once even when two reports of the duplicate race", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const first = [...stripe.sessions.keys()][0];
    await store.updateSession(first, { status: "expired" });
    await payments.checkoutUrl(GAME);
    const second = [...stripe.sessions.keys()][1];
    stripe.sessions.get(first)!.status = "open";
    const a = stripe.pay(first);
    const dup = stripe.pay(second);
    await payments.applySession(a, "webhook");
    await Promise.all([payments.applySession(dup, "webhook"), payments.applySession(dup, "return")]);
    // Same idempotency key both times, so Stripe made one refund.
    expect(new Set(stripe.refunds.map((r) => r.key)).size).toBe(1);
    expect(stripe.refunds).toHaveLength(1);
  });

  it("ignores sessions it didn't create, the wrong amount, or unpaid ones", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const id = [...stripe.sessions.keys()][0];
    const paid = stripe.pay(id);
    expect(await payments.applySession({ ...paid, id: "cs_test_someoneelse0000" }, "webhook")).toBe("ignored");
    expect(await payments.applySession({ ...paid, amount_total: 100 }, "webhook")).toBe("ignored");
    expect(await payments.applySession({ ...paid, currency: "eur" }, "webhook")).toBe("ignored");
    expect(await payments.applySession({ ...paid, payment_status: "unpaid" }, "webhook")).toBe("ignored");
    expect(await payments.applySession({ ...paid, metadata: { game: "precursors" } }, "webhook")).toBe("ignored");
    expect((await store.get(GAME))?.status).toBe("due");
  });

  it("webhook: rejects a bad signature without touching anything", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const paid = stripe.pay([...stripe.sessions.keys()][0]);
    const raw = checkoutCompletedEvent(paid);
    const r = await payments.handleWebhook(Buffer.from(raw), signWebhookPayload(raw, "whsec_wrong"));
    expect(r.status).toBe(400);
    expect((await store.get(GAME))?.status).toBe("due");
  });

  it("webhook: processes a replayed event once", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const paid = stripe.pay([...stripe.sessions.keys()][0]);
    const raw = checkoutCompletedEvent(paid);
    const r1 = await payments.handleWebhook(Buffer.from(raw), signWebhookPayload(raw, WEBHOOK_SECRET));
    const r2 = await payments.handleWebhook(Buffer.from(raw), signWebhookPayload(raw, WEBHOOK_SECRET));
    expect(r1.status).toBe(200);
    expect(r2.body).toMatchObject({ duplicate: true });
    expect(paidCalls).toEqual([GAME]);
  });

  it("confirm: reads the session from Stripe, not from the client", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const id = [...stripe.sessions.keys()][0];
    // Not paid yet: confirming changes nothing.
    expect((await payments.confirm(GAME, id)).body).toMatchObject({ outcome: "ignored", status: "due" });
    stripe.pay(id);
    expect((await payments.confirm(GAME, id)).body).toMatchObject({ outcome: "paid", status: "paid" });
    // A session for another game is not this child's.
    expect((await payments.confirm("99999999-2222-4333-8444-555555555555", id)).status).toBe(404);
  });

  it("confirm racing the webhook makes one transition", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const paid = stripe.pay([...stripe.sessions.keys()][0]);
    const raw = checkoutCompletedEvent(paid);
    await Promise.all([
      payments.confirm(GAME, paid.id),
      payments.handleWebhook(Buffer.from(raw), signWebhookPayload(raw, WEBHOOK_SECRET)),
    ]);
    expect(paidCalls).toEqual([GAME]);
    expect(stripe.refunds).toHaveLength(0);
  });

  it("expires the child's other open sessions once paid", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    const first = [...stripe.sessions.keys()][0];
    // Pretend a second one got created (e.g. by another process) and is still open.
    await store.updateSession(first, { status: "expired" });
    await payments.checkoutUrl(GAME);
    const second = [...stripe.sessions.keys()][1];
    stripe.sessions.get(first)!.status = "open";
    await store.updateSession(first, { status: "open" });
    await payments.applySession(stripe.pay(second), "webhook");
    expect(stripe.expireCalls).toContain(first);
  });

  it("admin refund: once, and the row says refunded", async () => {
    await dueChild();
    await payments.checkoutUrl(GAME);
    await payments.applySession(stripe.pay([...stripe.sessions.keys()][0]), "webhook");
    const r1 = await payments.adminRefund(GAME);
    const r2 = await payments.adminRefund(GAME);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(stripe.refunds).toHaveLength(1);
    expect((await store.get(GAME))?.status).toBe("refunded");
    // A refunded child is never asked to pay again.
    expect(await payments.openingAllowed(GAME, true)).toBe(true);
  });

  it("a child that was due when the switch went off plays free", async () => {
    await dueChild();
    cfg = paywallConfig({ switchOn: false });
    expect(await payments.openingAllowed(GAME, true)).toBe(true);
    expect(payments.view(GAME, "parent1")).toBeNull();
  });
});
