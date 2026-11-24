import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { HostStore } from "../src/hosts/store.js";
import type { StrangerStore } from "../src/stranger/store.js";
import type { HostEvent, HostPerson } from "../src/hosts/types.js";

// Needs DATABASE_URL pointing at a scratch Postgres; migrations (034 included) are applied here.
describe.skipIf(!process.env.DATABASE_URL)("host tools store on Postgres", () => {
  let store: HostStore;
  let runs: StrangerStore;
  let query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

  beforeAll(async () => {
    const { pool } = await import("../src/db/pool.js");
    const { migrate } = await import("../src/db/migrate.js");
    await migrate();
    const { PgGameRepository } = await import("../src/db/repository.js");
    const repo = new PgGameRepository(pool);
    store = repo.hosts;
    runs = repo.stranger;
    query = (sql, params) => pool.query(sql, params as unknown[]);
  });

  const person = (over: Partial<HostPerson> = {}): HostPerson => ({
    id: randomUUID(), subject: `s-${randomUUID()}`, displayName: "Dev", roleText: null, roleChecked: null, roleCheckedAt: null,
    agreementVersion: "short-form-1", agreementAt: Date.now(), status: "approved", createdAt: Date.now(), ...over,
  });
  const event = (over: Partial<HostEvent> = {}): HostEvent => {
    const t = Date.now();
    return {
      id: randomUUID(), codeHash: `h-${randomUUID()}`, source: "admin", name: "tuesday tea", kind: "studio", hostPersonId: null, guestReaderId: null,
      sensitive: false, authority: false, eventsBusiness: false, level: 0, shareCodes: false, studioLearning: false, handleExchange: true,
      welcomeText: "", lengthText: null, conductUrl: null, capacity: 100, joinWindowMs: 180_000, opensAt: t, closesAt: t + 86_400_000,
      paused: false, closedAt: null, cardVersion: 1, frozenTerms: null, firstAckAt: null, publishedFunnel: null, publishedAt: null, createdAt: t, ...over,
    };
  };

  it("people and events round-trip; a subject is one person", async () => {
    const p = person({ roleText: "counsellor", roleChecked: "site", roleCheckedAt: 5 });
    expect(await store.createPerson(p)).toBe(true);
    expect(await store.createPerson({ ...p, id: randomUUID() })).toBe(false);
    expect(await store.getPerson(p.id)).toEqual(p);
    expect((await store.personBySubject(p.subject))?.id).toBe(p.id);
    const e = event({ kind: "outside", hostPersonId: p.id, level: 1 });
    await store.createEvent(e);
    expect(await store.getEvent(e.id)).toEqual(e);
    const u = await store.updateEvent(e.id, { paused: true, cardVersion: 2 });
    expect(u?.paused).toBe(true);
    expect(u?.cardVersion).toBe(2);
  });

  it("the database holds the ceilings too", async () => {
    const p = person();
    await store.createPerson(p);
    await expect(store.createEvent(event({ kind: "outside", hostPersonId: p.id, level: 3, shareCodes: true, authority: true }))).rejects.toThrow();
    await expect(store.createEvent(event({ kind: "outside", hostPersonId: null, level: 1 }))).rejects.toThrow();
    await expect(store.createEvent(event({ kind: "studio", level: 3, shareCodes: true }))).rejects.toThrow();
    await expect(store.createEvent(event({ closesAt: Date.now() + 15 * 86_400_000 }))).rejects.toThrow();
    await expect(store.createEvent(event({ sensitive: true, kind: "outside", hostPersonId: p.id, level: 1 }))).rejects.toThrow();
  });

  it("terms freeze once; acknowledgements bind, count and unlist", async () => {
    const e = event();
    await store.createEvent(e);
    const terms = { cost: "free" as const, traceRetentionDays: null, traceWhere: "studio" as const, handleExchange: true, learning: false };
    expect(await store.freezeTerms(e.id, terms, 10)).toBe(true);
    expect(await store.freezeTerms(e.id, { ...terms, cost: "first_parent" }, 11)).toBe(false);
    const got = await store.getEvent(e.id);
    expect(got?.frozenTerms).toEqual(terms);
    expect(got?.firstAckAt).toBe(10);
    await store.saveCard(e.id, 1, { hello: "card" });
    await store.saveCard(e.id, 1, { hello: "card" });
    expect(await store.getCard(e.id, 1)).toEqual({ hello: "card" });
    const id = randomUUID();
    const sub = `subj-${randomUUID()}`;
    const hash = `t-${randomUUID()}`;
    await store.addAck({ id, eventId: e.id, cardVersion: 1, preTokenHash: hash, subject: null, at: 1, boundAt: null, queuedAt: null, unlistedAt: null });
    expect((await store.ackByTokenHash(hash))?.id).toBe(id);
    await store.bindAck(id, sub, 2);
    expect((await store.acksForSubject(sub)).map((a) => a.eventId)).toEqual([e.id]);
    expect(await store.hasQueued(sub, e.id)).toBe(false);
    await store.markQueued(sub, e.id, 3);
    await store.markQueued(sub, e.id, 4);
    expect(await store.countQueued(e.id)).toBe(1);
    expect(await store.hasQueued(sub, e.id)).toBe(true);
  });

  it("stranger_runs carry the event, not the code, and mark finished", async () => {
    const e = event();
    await store.createEvent(e);
    const gameId = randomUUID();
    await query("INSERT INTO games (id, child_name, phase, created_at) VALUES ($1, 'Wren', 'lobby', NOW()) ON CONFLICT DO NOTHING", [gameId]).catch(() => {});
    await runs.createRun({ gameId, parent1: "s1", parent2: "s2", meetupCode: null, eventId: e.id });
    expect((await runs.getRun(gameId))?.eventId).toBe(e.id);
    await runs.markRunFinished(gameId, 99);
    const list = await runs.runsForEvent(e.id);
    expect(list).toHaveLength(1);
    expect(list[0].finishedAt).toBe(99);
  });

  it("host reports round-trip", async () => {
    const id = randomUUID();
    await store.addHostReport({ id, eventId: null, text: "hm", at: 1, status: "open" });
    expect((await store.listHostReports()).some((r) => r.id === id)).toBe(true);
    expect(await store.setHostReportStatus(id, "done")).toBe(true);
  });
});
