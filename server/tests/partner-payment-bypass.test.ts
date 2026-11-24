import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { LLMRole } from "../src/llm/model-config.js";
import { PartnerPayments } from "../src/payments/partner-payments.js";
import { TestClient, connect, OCEAN_P1, OCEAN_P2 } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import type { GameEvent } from "../src/types.js";
import { FakeCheckout, paywallConfig } from "./helpers/fake-stripe.js";

/**
 * Ways a two-human child could get generated content without the host
 * paying. Billing must follow the seats people actually hold on the server,
 * never what the client says the game is, and must hold at every step that
 * generates something, not only the opening.
 */

function event(n: number): GameEvent {
  return { eventNumber: n, age: 3, description: `Scenario ${n}.`, setting: "Home", trigger: "Test" };
}

class CountingMock extends MockLLMClient {
  seedCalls = 0;
  override async completeResponse(system: string, user: string, max?: number, role?: LLMRole, onChunk?: (c: string) => void) {
    if (role === "personality_seed") {
      this.seedCalls++;
      return "SEED";
    }
    return super.completeResponse(system, user, max, role, onChunk);
  }
  generated(): number {
    return this.seedCalls + this.roleCalls.filter((r) => r !== "safety_check").length;
  }
}

describe("partner payment cannot be bypassed", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: CountingMock;
  let repo: InMemoryGameRepository;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new CountingMock();
    mock.events = [event(1), event(2), event(3)];
    repo = new InMemoryGameRepository();
    const payments = new PartnerPayments({ store: repo.partnerPayments, config: () => paywallConfig(), checkout: new FakeCheckout() });
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
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function host(relationshipType?: string) {
    const p1 = await client();
    const j1 = p1.once<{ gameId: string; playerToken: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Ilse", displayName: "Host", ...(relationshipType ? { relationshipType } : {}) });
    const { gameId, playerToken } = await j1;
    return { p1, gameId, hostToken: playerToken };
  }

  async function join(gameId: string) {
    const p2 = await client();
    const j2 = p2.once<{ playerToken: string }>(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId, displayName: "Partner" });
    const { playerToken } = await j2;
    return { p2, partnerToken: playerToken };
  }

  const settle = () => new Promise((r) => setTimeout(r, 150));

  it("a game the client calls solo is still charged once a second person sits down", async () => {
    const { p1, gameId } = await host("solo parent");
    const { p2 } = await join(gameId);
    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    p2.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P2, confessional1: "b", confessional2: "" });
    await due;
    await settle();
    expect(mock.seedCalls).toBe(0);
    expect(mock.generated()).toBe(0);
  });

  it("a partner who joins a solo game mid-story stops every further generation until paid", async () => {
    const { p1, gameId, hostToken } = await host("solo parent");
    const chat = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    await chat;
    await settle();
    // Solo up to here, free, as it should be.
    expect(await repo.partnerPayments.get(gameId)).toBeNull();

    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    const { p2 } = await join(gameId);
    expect((await due).payment?.youPay).toBe(true);
    expect((await repo.partnerPayments.get(gameId))?.status).toBe("due");

    const before = mock.generated();
    p1.emit(E.PARENT_MESSAGE, { content: "hello love" });
    p2.emit(E.PARENT_MESSAGE, { content: "hi" });
    p1.emit(E.END_CHAT);
    await settle();
    expect(mock.generated()).toBe(before);
    expect((await post(`/api/game/${gameId}/next-event`, {}, { "x-player-token": hostToken })).status).toBe(402);
  });

  it("REST /personality can't answer for a seat nobody holds", async () => {
    const { gameId, hostToken } = await host();
    // The host tries to fill in the partner's quiz before anyone has joined.
    const p2Answer = await post(`/api/game/${gameId}/personality`, { ocean: OCEAN_P2, confessional1: "x", slot: "parent2", playerToken: hostToken });
    expect(p2Answer.status).toBe(403);
    const noToken = await post(`/api/game/${gameId}/personality`, { ocean: OCEAN_P1, confessional1: "x", slot: "parent1" });
    expect(noToken.status).toBe(403);
    expect(mock.seedCalls).toBe(0);
    expect(built.games.get(gameId)?.parentPersonalities.parent2).toBeFalsy();
  });

  it("REST /personality on a seated game needs that seat's own token", async () => {
    const { gameId, hostToken } = await host();
    const { partnerToken } = await join(gameId);
    expect((await post(`/api/game/${gameId}/personality`, { ocean: OCEAN_P2, confessional1: "x", slot: "parent2", playerToken: hostToken })).status).toBe(403);
    expect((await post(`/api/game/${gameId}/personality`, { ocean: OCEAN_P1, confessional1: "x", slot: "parent1", playerToken: hostToken })).status).toBe(200);
    const both = await post(`/api/game/${gameId}/personality`, { ocean: OCEAN_P2, confessional1: "x", slot: "parent2", playerToken: partnerToken });
    expect(both.status).toBe(200);
    expect(both.body).toMatchObject({ ready: false, paymentDue: true });
    expect(mock.seedCalls).toBe(0);
  });

  it("RETRY_OPENING won't build scene 1 for an unpaid child that somehow has a seed", async () => {
    const { p1, gameId } = await host();
    const { p2 } = await join(gameId);
    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    p2.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P2, confessional1: "b", confessional2: "" });
    await due;
    const state = built.games.get(gameId)!;
    built.games.set(gameId, { ...state, personalitySeed: "SMUGGLED" });
    p1.emit(E.RETRY_OPENING);
    await settle();
    expect(mock.generated()).toBe(0);
    expect(built.games.get(gameId)?.phase).toBe("event_intro");
  });

  it("every generating REST route refuses an unpaid two-human child, however the path is spelled", async () => {
    const { p1, gameId, hostToken } = await host();
    const seat = { "x-player-token": hostToken };
    const { p2 } = await join(gameId);
    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    p2.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P2, confessional1: "b", confessional2: "" });
    await due;
    const routes = [
      "next-event", "message", "end-chat", "end-debrief", "repair", "end-consult", "end-therapy",
      "end-cps", "therapy-message", "portraits/next", "epilogue", "adult-chat", "report-card",
    ];
    const spellings = (r: string) => [r, r.toUpperCase(), r[0].toUpperCase() + r.slice(1), `${r}/`, `${r.toUpperCase()}/`];
    for (const r of routes) {
      for (const path of spellings(r)) {
        const res = await post(`/api/game/${gameId}/${path}`, { content: "hi", message: "hi" }, seat);
        expect({ path, status: res.status }).toEqual({ path, status: 402 });
      }
      // The game id itself in another case is just another (unknown) game — never generated for.
      const upper = await post(`/api/GAME/${gameId}/${r}`, { content: "hi" }, seat);
      expect([402, 404]).toContain(upper.status);
    }
    await settle();
    expect(mock.generated()).toBe(0);
  });

  it("the REST gate counts saved seats, not just the ones live in memory", async () => {
    const { p1, gameId, hostToken } = await host();
    const { p2 } = await join(gameId);
    const due = p1.waitFor<ViewerState>(E.STATE, (s) => s.payment?.status === "due");
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    p2.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P2, confessional1: "b", confessional2: "" });
    await due;
    // As if the server restarted: the live session is gone, the seats are saved.
    built.sessions.delete(gameId);
    expect((await post(`/api/game/${gameId}/next-event`, {}, { "x-player-token": hostToken })).status).toBe(402);
  });

  it("a partner who joins and leaves before the quiz is never charged, and a solo child stays free", async () => {
    const { p1, gameId } = await host();
    const { p2 } = await join(gameId);
    p2.close();
    p1.emit(E.READY, {});
    await settle();
    expect(await repo.partnerPayments.get(gameId)).toBeNull();

    const solo = await host("solo parent");
    const chat = solo.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    solo.p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "a", confessional2: "" });
    await chat;
    expect(await repo.partnerPayments.get(solo.gameId)).toBeNull();
  });
});
