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
});
