import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { LLMRole } from "../src/llm/model-config.js";
import { PartnerPayments } from "../src/payments/partner-payments.js";
import type { PaymentConfig } from "../src/payments/config.js";
import { signWebhookPayload } from "../src/payments/stripe.js";
import { TestClient, connect, OCEAN_P1, OCEAN_P2 } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import type { GameEvent } from "../src/types.js";
import { FakeCheckout, WEBHOOK_SECRET, checkoutCompletedEvent, paywallConfig } from "./helpers/fake-stripe.js";

/**
 * The $20 per-child partner payment through the real socket stack: the host
 * is charged when the partner has joined (both parents' answers in), never
 * before, never twice, and nothing is generated for the child until then.
 */

function event(n: number): GameEvent {
  return { eventNumber: n, age: 3, description: `Scenario ${n}.`, setting: "Home", trigger: "Test" };
}

class CountingMock extends MockLLMClient {
  seedCalls = 0;
  worldManagerCalls = 0;
  override async completeJson<T>(system: string, user: string, role?: LLMRole): Promise<T> {
    if (role === "world_manager") this.worldManagerCalls++;
    return super.completeJson<T>(system, user, role);
  }
  override async completeResponse(system: string, user: string, max?: number, role?: LLMRole, onChunk?: (c: string) => void) {
    if (role === "personality_seed") {
      this.seedCalls++;
      return "SEED";
    }
    return super.completeResponse(system, user, max, role, onChunk);
  }
}

describe("partner payment over the socket", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: CountingMock;
  let repo: InMemoryGameRepository;
  let stripe: FakeCheckout;
  let cfg: PaymentConfig;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new CountingMock();
    mock.events = [event(1), event(2)];
    repo = new InMemoryGameRepository();
    stripe = new FakeCheckout();
    cfg = paywallConfig();
    const payments = new PartnerPayments({ store: repo.partnerPayments, config: () => cfg, checkout: stripe });
    built = buildServer({
      llm: mock,
      repo,
      adminQueries: new InMemoryAdminQueries(),
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
      payments,
    });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await built.close();
  });

  async function client(): Promise<TestClient> {
    const c = await connect(baseUrl);
    clients.push(c);
    return c;
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** Host creates, partner joins; returns ids and tokens. */
  async function pair() {
    const p1 = await client();
    const j1 = p1.once<{ gameId: string; playerToken: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Ilse", displayName: "Host" });
    const { gameId, playerToken: hostToken } = await j1;
    const p2 = await client();
    const j2 = p2.once<{ playerToken: string }>(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId, displayName: "Partner" });
    const { playerToken: partnerToken } = await j2;
    return { p1, p2, gameId, hostToken, partnerToken };
  }

  async function bothSubmit(p1: TestClient, p2: TestClient) {
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    p2.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P2, confessional1: "b", confessional2: "" });
  }

  it("with the paywall off, a two-parent opening runs exactly as before", async () => {
    cfg = paywallConfig({ switchOn: false });
    const { p1, p2, gameId } = await pair();
    const chat = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    await bothSubmit(p1, p2);
    const s = await chat;
    expect(s.payment).toBeNull();
    expect(mock.seedCalls).toBe(1);
    expect(await repo.partnerPayments.get(gameId)).toBeNull();
  });

  it("stops the opening at 'due' and generates nothing for the child", async () => {
    const { p1, p2, gameId, hostToken } = await pair();
    const dueHost = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    const duePartner = p2.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    await bothSubmit(p1, p2);
    expect((await dueHost).payment).toEqual({ status: "due", youPay: true, amountCents: 2000 });
    expect((await duePartner).payment).toEqual({ status: "due", youPay: false, amountCents: 2000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(mock.seedCalls).toBe(0);
    expect(mock.worldManagerCalls).toBe(0);
    expect(built.games.get(gameId)?.phase).toBe("event_intro");
    // REST side doors are shut too, even to a seat.
    expect((await post(`/api/game/${gameId}/next-event`, {}, { "x-player-token": hostToken })).status).toBe(402);
  });

  it("does not charge before the partner joins, or before they finish the quiz", async () => {
    const p1 = await client();
    const j1 = p1.once<{ gameId: string; playerToken: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Ilse" });
    const { gameId, playerToken } = await j1;
    // Invite sent, nobody joined.
    expect((await post("/api/partner-payment/checkout", { gameId, playerToken })).status).toBe(409);
    // The partner opens the link (a chat app's preview could do this too)…
    const p2 = await client();
    const j2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await j2;
    // …and the host finishes the quiz, but the partner never does.
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    await new Promise((r) => setTimeout(r, 150));
    p2.close();
    expect(await repo.partnerPayments.get(gameId)).toBeNull();
    expect((await post("/api/partner-payment/checkout", { gameId, playerToken })).status).toBe(409);
    expect(stripe.createCalls).toBe(0);
  });

  it("only the host can open checkout, and a second click reuses the session", async () => {
    const { p1, p2, gameId, hostToken, partnerToken } = await pair();
    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    await bothSubmit(p1, p2);
    await due;
    expect((await post("/api/partner-payment/checkout", { gameId, playerToken: partnerToken })).status).toBe(403);
    expect((await post("/api/partner-payment/checkout", { gameId, playerToken: "x".repeat(36) })).status).toBe(403);
    const [a, b] = await Promise.all([
      post("/api/partner-payment/checkout", { gameId, playerToken: hostToken }),
      post("/api/partner-payment/checkout", { gameId, playerToken: hostToken }),
    ]);
    expect(a.status).toBe(200);
    expect(a.body.url).toBe(b.body.url);
    expect(stripe.sessions.size).toBe(1);
  });

  it("reconnects and retried joins never create a second charge", async () => {
    const { p1, p2, gameId, hostToken, partnerToken } = await pair();
    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    await bothSubmit(p1, p2);
    await due;
    await post("/api/partner-payment/checkout", { gameId, playerToken: hostToken });
    // Partner drops and rejoins twice; host re-submits the quiz (a retry).
    for (let i = 0; i < 2; i++) {
      const again = await client();
      const j = again.once(E.JOINED);
      again.emit(E.JOIN_GAME, { gameId, playerToken: partnerToken });
      await j;
    }
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    p1.emit(E.RETRY_OPENING);
    await new Promise((r) => setTimeout(r, 150));
    await post("/api/partner-payment/checkout", { gameId, playerToken: hostToken });
    expect(stripe.sessions.size).toBe(1);
    expect((await repo.partnerPayments.get(gameId))?.status).toBe("due");
    expect(mock.seedCalls).toBe(0);
  });

  it("the webhook settles it and the opening runs once", async () => {
    const { p1, p2, gameId, hostToken } = await pair();
    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    await bothSubmit(p1, p2);
    await due;
    await post("/api/partner-payment/checkout", { gameId, playerToken: hostToken });
    const paid = stripe.pay([...stripe.sessions.keys()][0]);
    const raw = checkoutCompletedEvent(paid);

    const chat1 = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    const chat2 = p2.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    const hook = await post("/api/stripe/webhook", raw, { "Stripe-Signature": signWebhookPayload(raw, WEBHOOK_SECRET) });
    expect(hook.status).toBe(200);
    // The player's return confirms too, and a client nudges a retry.
    await post("/api/partner-payment/confirm", { gameId, sessionId: paid.id });
    p2.emit(E.RETRY_OPENING);
    const s1 = await chat1;
    await chat2;
    expect(s1.payment).toEqual({ status: "paid", youPay: true, amountCents: 2000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(mock.seedCalls).toBe(1);
    expect(mock.worldManagerCalls).toBe(1);
    expect(stripe.refunds).toHaveLength(0);
  });

  it("a forged webhook changes nothing", async () => {
    const { p1, p2, gameId, hostToken } = await pair();
    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    await bothSubmit(p1, p2);
    await due;
    await post("/api/partner-payment/checkout", { gameId, playerToken: hostToken });
    const session = [...stripe.sessions.values()][0];
    const forged = checkoutCompletedEvent({ ...session, payment_status: "paid", status: "complete", payment_intent: "pi_x" });
    expect((await post("/api/stripe/webhook", forged, { "Stripe-Signature": signWebhookPayload(forged, "whsec_attacker") })).status).toBe(400);
    expect((await post("/api/stripe/webhook", forged)).status).toBe(400);
    expect((await repo.partnerPayments.get(gameId))?.status).toBe("due");
    // And the client can't claim it either: confirm asks Stripe, which says unpaid.
    const c = await post("/api/partner-payment/confirm", { gameId, sessionId: session.id });
    expect(c.body.status).toBe("due");
  });

  it("solo play is never touched", async () => {
    const res = await post("/api/game", { childName: "Solo", relationshipType: "solo parent", birthYear: 1990 });
    expect(res.status).toBe(200);
    const id = res.body.gameId as string;
    const secret = res.body.secret as string;
    expect((await post(`/api/game/${id}/next-event`, {}, { "x-game-secret": secret })).status).toBe(200);
  });
});
