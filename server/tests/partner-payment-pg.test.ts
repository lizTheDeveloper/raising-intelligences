import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

// Needs DATABASE_URL pointing at a scratch Postgres; migrations are applied here.
describe.skipIf(!process.env.DATABASE_URL)("partner payments on Postgres", () => {
  let store: import("../src/payments/store.js").PartnerPaymentStore;

  beforeAll(async () => {
    const { pool } = await import("../src/db/pool.js");
    const { migrate } = await import("../src/db/migrate.js");
    await migrate();
    const { PgGameRepository } = await import("../src/db/repository.js");
    store = new PgGameRepository(pool).partnerPayments;
  });

  it("due is insert-once, and due → paid happens exactly once under a race", async () => {
    const game = randomUUID();
    const [a, b] = await Promise.all([store.markDue(game, 2000, "usd"), store.markDue(game, 2000, "usd")]);
    expect(a.status).toBe("due");
    expect(b.status).toBe("due");
    await store.addSession({ sessionId: `cs_test_${game}`, gameId: game, url: "u", expiresAt: Date.now() + 3600_000, status: "open", paymentIntentId: null, refundId: null, createdAt: Date.now() });
    const results = await Promise.all([
      store.markPaid(game, "cs_1", "pi_1", false),
      store.markPaid(game, "cs_2", "pi_2", false),
      store.markPaid(game, "cs_1", "pi_1", false),
    ]);
    expect(results.filter((r) => r.transitioned)).toHaveLength(1);
    const row = await store.get(game);
    expect(row?.status).toBe("paid");
    expect(["cs_1", "cs_2"]).toContain(row?.paidSessionId);
    await store.updateSession(`cs_test_${game}`, { status: "duplicate_refunded", refundId: "re_1" });
    expect((await store.listSessions(game))[0]).toMatchObject({ status: "duplicate_refunded", refundId: "re_1" });
    await store.markRefunded(game, "re_2");
    expect((await store.get(game))?.status).toBe("refunded");
  });

  it("records each webhook event once", async () => {
    const id = `evt_${randomUUID()}`;
    expect(await store.hasEvent(id)).toBe(false);
    await store.recordEvent(id, "checkout.session.completed");
    await store.recordEvent(id, "checkout.session.completed");
    expect(await store.hasEvent(id)).toBe(true);
  });
});
