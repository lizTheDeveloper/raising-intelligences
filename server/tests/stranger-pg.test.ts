import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

// Needs DATABASE_URL pointing at a scratch Postgres; migrations are applied here.
describe.skipIf(!process.env.DATABASE_URL)("stranger store on Postgres", () => {
  let store: import("../src/stranger/store.js").StrangerStore;

  beforeAll(async () => {
    const { pool } = await import("../src/db/pool.js");
    const { migrate } = await import("../src/db/migrate.js");
    await migrate();
    const { PgGameRepository } = await import("../src/db/repository.js");
    store = new PgGameRepository(pool).stranger;
  });

  it("a minor outcome is final; an adult one can be refreshed", async () => {
    const minor = `s-${randomUUID()}`;
    await store.setVerification({ subject: minor, outcome: "minor", livemode: true, verifiedAt: Date.now(), sessionId: "vs_1" });
    const after = await store.setVerification({ subject: minor, outcome: "adult", livemode: true, verifiedAt: Date.now(), sessionId: "vs_2" });
    expect(after.outcome).toBe("minor");
    const adult = `s-${randomUUID()}`;
    await store.setVerification({ subject: adult, outcome: "adult", livemode: false, verifiedAt: Date.now(), sessionId: "vs_3" });
    expect((await store.setVerification({ subject: adult, outcome: "adult", livemode: true, verifiedAt: Date.now(), sessionId: "vs_4" })).livemode).toBe(true);
  });

  it("consent, sessions and the daily count round-trip", async () => {
    const s = `s-${randomUUID()}`;
    await store.recordConsent({ subject: s, version: "v1", at: Date.now() });
    expect((await store.getConsent(s))?.version).toBe("v1");
    await store.addVerificationSession({ sessionId: `vs_${randomUUID()}`, subject: s, createdAt: Date.now() - 1000 });
    const last = `vs_${randomUUID()}`;
    await store.addVerificationSession({ sessionId: last, subject: s, createdAt: Date.now() });
    expect((await store.latestVerificationSession(s))?.sessionId).toBe(last);
    expect(await store.countVerificationSessionsSince(s, Date.now() - 60_000)).toBe(2);
    expect((await store.getVerificationSession(last))?.subject).toBe(s);
  });

  it("check slots: parallel reservations never exceed the cap", async () => {
    const s = `s-${randomUUID()}`;
    const got = await Promise.all(Array.from({ length: 10 }, () => store.reserveCheckSlot(s, "2026-11-23", 3)));
    expect(got.filter((g) => g !== null).sort()).toEqual([1, 2, 3]);
    expect(await store.reserveCheckSlot(s, "2026-11-24", 3)).toBe(1);
  });

  it("one document binds to one account, even under a race", async () => {
    const doc = `d-${randomUUID()}`;
    const [a, b] = await Promise.all([store.bindDocument(doc, "subject-a", Date.now()), store.bindDocument(doc, "subject-b", Date.now())]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ? "subject-a" : "subject-b";
    expect(await store.bindDocument(doc, winner, Date.now())).toBe(true);
  });

  it("runs, blocks (either order) and suspensions round-trip", async () => {
    const g = randomUUID();
    await store.createRun({ gameId: g, meetupCode: "tea-party", parent1: "s1", parent2: "s2" });
    expect(await store.getRun(g)).toEqual({ gameId: g, meetupCode: "tea-party", parent1: "s1", parent2: "s2" });
    expect(await store.getRun(randomUUID())).toBeNull();
    await store.discardRun(g);
    expect((await store.getRun(g))?.discarded).toBe(true);
    const a = `a-${randomUUID()}`, b = `b-${randomUUID()}`;
    await store.addBlock(b, a);
    expect(await store.isBlocked(a, b)).toBe(true);
    expect(await store.isBlocked(b, a)).toBe(true);
    await store.suspend(a, "report");
    expect(await store.isSuspended(a)).toBe(true);
    await store.lift(a);
    expect(await store.isSuspended(a)).toBe(false);
  });

  it("reports: one per seat per game, resolved once, found by game and by subject", async () => {
    const g = randomUUID();
    const row = { id: randomUUID(), gameId: g, reporter: "r1", reported: "x1", reason: "why", createdAt: Date.now(), status: "open" as const };
    expect(await store.addReport(row)).toBe(true);
    expect(await store.addReport({ ...row, id: randomUUID() })).toBe(false);
    expect(await store.gameReported(g)).toBe(true);
    expect((await store.reportsForGame(g)).map((r) => r.id)).toEqual([row.id]);
    expect((await store.reportsAgainst("x1")).some((r) => r.id === row.id)).toBe(true);
    expect(await store.resolveReport(row.id, "lifted")).toBe(true);
    expect(await store.resolveReport(row.id, "kept")).toBe(false);
    expect((await store.getReport(row.id))?.status).toBe("lifted");
  });

  it("lift in one step, listing filter, reports by reporter, exchange outcome", async () => {
    const x = `x-${randomUUID()}`;
    await store.suspend(x, "report");
    const id = randomUUID();
    await store.addReport({ id, gameId: randomUUID(), reporter: `r-${randomUUID()}`, reported: x, reason: "a", createdAt: Date.now(), status: "open" });
    expect(await store.liftIfUnheld(x)).toBe(false);
    expect(await store.isSuspended(x)).toBe(true);
    await store.resolveReport(id, "lifted");
    expect(await store.liftIfUnheld(x)).toBe(true);
    expect(await store.isSuspended(x)).toBe(false);
    const listed = await store.listReports(500, { statuses: ["lifted"] });
    expect(listed.some((r) => r.id === id)).toBe(true);
    expect((await store.listReports(500, { statuses: ["open"] })).some((r) => r.id === id)).toBe(false);
    const g = randomUUID();
    expect(await store.exchangeOutcome(g)).toBeNull();
    await store.closeExchange(g, "closed");
    await store.closeExchange(g, "revealed");
    expect(await store.exchangeOutcome(g)).toBe("closed");
  });
});
