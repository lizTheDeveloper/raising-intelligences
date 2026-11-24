import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { HostStore } from "../src/hosts/store.js";
import type { StrangerStore } from "../src/stranger/store.js";
import type { HostEvent, HostPerson } from "../src/hosts/types.js";
import type { GameRepository } from "../src/db/repository.js";
import type { ChildSafetyStore } from "../src/safety/child-safety/store.js";
import { createGame } from "../src/game/state-machine.js";

// Needs DATABASE_URL pointing at a scratch Postgres; migrations (034 included) are applied here.
describe.skipIf(!process.env.DATABASE_URL)("host tools store on Postgres", () => {
  let store: HostStore;
  let runs: StrangerStore;
  let repoAll: GameRepository;
  let childSafety: ChildSafetyStore;
  let query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

  beforeAll(async () => {
    const { pool } = await import("../src/db/pool.js");
    const { migrate } = await import("../src/db/migrate.js");
    await migrate();
    const { PgGameRepository } = await import("../src/db/repository.js");
    const repo = new PgGameRepository(pool);
    store = repo.hosts;
    repoAll = repo;
    childSafety = repo.childSafety;
    runs = repo.stranger;
    query = (sql, params) => pool.query(sql, params as unknown[]);
  });

  const person = (over: Partial<HostPerson> = {}): HostPerson => ({
    id: randomUUID(), subject: `s-${randomUUID()}`, displayName: "Dev", roleText: null, roleChecked: null, roleCheckedAt: null,
    agreementVersion: "short-form-1", agreementAt: Date.now(), status: "approved", createdAt: Date.now(), hostType: "club", organisation: null, ...over,
  });
  const event = (over: Partial<HostEvent> = {}): HostEvent => {
    const t = Date.now();
    return {
      id: randomUUID(), codeHash: `h-${randomUUID()}`, source: "admin", name: "tuesday tea", kind: "studio", hostPersonId: null, guestReaderId: null, promoterIds: [], codeSeq: 0,
      sensitive: false, authority: false, eventsBusiness: false, level: 0, shareCodes: false, studioLearning: false, handleExchange: true,
      welcomeText: "", lengthText: null, conductUrl: null, capacity: 100, joinWindowMs: 180_000, opensAt: t, closesAt: t + 86_400_000,
      paused: false, pausedBy: null, closedAt: null, cardVersion: 1, frozenTerms: null, firstAckAt: null, publishedFunnel: null, publishedAt: null, createdAt: t, ...over,
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

  it("share codes: by reader; endgames load; a case names a game; paused_by round-trips", async () => {
    const p = person();
    await store.createPerson(p);
    const e = event({ kind: "outside", hostPersonId: p.id, level: 3, shareCodes: true, handleExchange: false, paused: true, pausedBy: "admin" });
    await store.createEvent(e);
    expect((await store.getEvent(e.id))?.pausedBy).toBe("admin");
    expect((await store.updateEvent(e.id, { paused: false, pausedBy: null }))?.pausedBy).toBeNull();
    const code = {
      id: randomUUID(), gameId: randomUUID(), eventId: e.id, codeHash: `c-${randomUUID()}`,
      snapshot: { reportCard: "r", epilogue: "e", reportCardOmitted: false }, visibleAt: 1, expiresAt: 2,
      redeemedBy: null, redeemedAt: null, accessUntil: null, stoppedAt: null, stoppedBy: null,
    };
    expect(await store.insertCode(code)).toBe(true);
    expect(await store.codesForReader(p.id)).toEqual([]);
    expect(await store.redeemCode(code.id, p.id, 10, 20)).toBe(true);
    expect((await store.codesForReader(p.id)).map((c) => c.id)).toEqual([code.id]);
    await store.updateCode(code.id, { stoppedAt: 30, stoppedBy: null });
    expect((await store.getCode(code.id))?.stoppedAt).toBe(30);

    const state = { ...createGame("Pg"), phase: "report_card" as const };
    await repoAll.saveGame(state);
    expect(await repoAll.loadEndgame(state.id)).toBeNull();
    await repoAll.saveEndgame(state.id, "the epilogue", "the card");
    expect(await repoAll.loadEndgame(state.id)).toEqual({ epilogue: "the epilogue", reportCard: "the card" });

    expect(await childSafety.hasCaseForGame(state.id)).toBe(false);
    await query(
      `INSERT INTO child_safety.evidence_cases (id, source, game_ref, incident_at, content_sha256, key_id, ciphertext, is_test)
       VALUES ($1, 'synthetic_test', $2, now(), 'x', 'k', 'x', true)`,
      [randomUUID(), state.id],
    ).catch(async (err) => { throw new Error(`insert case: ${err.message}`); });
    expect(await childSafety.hasCaseForGame(state.id)).toBe(true);
    const banned = `@banned-${randomUUID()}:x`;
    expect(await childSafety.bannedValues("matrix")).not.toContain(banned);
    await childSafety.banIdentifier({ kind: "matrix", value: banned }, "t", null);
    expect(await childSafety.bannedValues("matrix")).toContain(banned);
  });
  it("learning, unlink and the purge round-trip (PR 4)", async () => {
    const e = event({ kind: "studio", studioLearning: true, closesAt: 1_000, opensAt: 0 });
    await store.createEvent(e);
    const gameId = randomUUID();
    // Learning: the first answer stands, one per seat; deleted per seat.
    await store.setLearning(gameId, "parent1", "yes", 1);
    await store.setLearning(gameId, "parent1", "no", 2);
    await store.setLearning(gameId, "parent2", "yes", 3);
    expect((await store.getLearning(gameId)).sort((a, b) => a.slot.localeCompare(b.slot))).toEqual([
      { slot: "parent1", answer: "yes" }, { slot: "parent2", answer: "yes" },
    ]);
    expect(await store.learningGames()).toContain(gameId);
    await store.deleteLearning(gameId, "parent1");
    expect(await store.getLearning(gameId)).toEqual([{ slot: "parent2", answer: "yes" }]);
    // Withdrawal from the account page: a yes becomes no; an unanswered seat gets a no.
    await store.withdrawLearning(gameId, "parent2", 4);
    await store.withdrawLearning(gameId, "parent1", 5);
    expect((await store.getLearning(gameId)).sort((a, b) => a.slot.localeCompare(b.slot))).toEqual([
      { slot: "parent1", answer: "no" }, { slot: "parent2", answer: "no" },
    ]);

    // Decisions and acknowledgements go per seat / per subject.
    await store.setDecision({ gameId, slot: "parent1", answer: "later", at: 1, windowEndsAt: 50 });
    await store.setDecision({ gameId, slot: "parent2", answer: "yes", at: 1, windowEndsAt: 50 });
    await store.deleteDecisions(gameId, "parent1");
    expect((await store.getDecisions(gameId)).map((d) => d.slot)).toEqual(["parent2"]);
    const sub = `subj-${randomUUID()}`;
    await store.addAck({ id: randomUUID(), eventId: e.id, cardVersion: 1, preTokenHash: `t-${randomUUID()}`, subject: sub, at: 1, boundAt: 1, queuedAt: null, unlistedAt: null });
    await store.deleteAcks(sub, e.id);
    expect(await store.acksForSubject(sub)).toEqual([]);

    // Unlink requests: done once; the run's seat is replaced.
    const u = { id: randomUUID(), gameId, subject: sub, at: 5, doneAt: null };
    await store.addUnlink(u);
    expect(await store.getUnlink(u.id)).toEqual(u);
    expect((await store.listUnlinks()).some((x) => x.id === u.id)).toBe(true);
    expect(await store.markUnlinkDone(u.id, 6)).toBe(true);
    expect(await store.markUnlinkDone(u.id, 7)).toBe(false);
    expect((await store.getUnlink(u.id))?.doneAt).toBe(6);
    await runs.createRun({ gameId, parent1: sub, parent2: "other", meetupCode: null, eventId: e.id });
    await runs.unlinkRunSeat(gameId, "parent1", `unlinked:${u.id}`);
    expect((await runs.getRun(gameId))?.parent1).toBe(`unlinked:${u.id}`);
    expect((await runs.runsForSubject(sub)).some((r) => r.gameId === gameId)).toBe(false);

    // The purge: counts only, per table; the done unlink goes after its period.
    const counts = await store.purge(10_000, { ackAfterCloseMs: 1, eventRecordsAfterCloseMs: 1, codeAfterLiveMs: 1, unlinkDoneMs: 1 });
    for (const v of Object.values(counts)) expect(typeof v).toBe("number");
    expect(counts.share_decisions).toBeGreaterThanOrEqual(1);
    expect(counts.unlink_requests).toBeGreaterThanOrEqual(1);
    expect(await store.getUnlink(u.id)).toBeNull();
  });

  it("migration 036: host type, organisation and promoters round-trip; the type column refuses anything else", async () => {
    const p = person({ hostType: "events_business", organisation: "Spark Night" });
    await store.createPerson(p);
    const got = await store.getPerson(p.id);
    expect(got?.hostType).toBe("events_business");
    expect(got?.organisation).toBe("Spark Night");
    await store.updatePerson(p.id, { hostType: "club", organisation: null });
    expect((await store.getPerson(p.id))?.hostType).toBe("club");
    await expect(query(`UPDATE host_people SET host_type = 'wizard' WHERE id = $1`, [p.id])).rejects.toThrow();
    const e = event({ promoterIds: [p.id] });
    await store.createEvent(e);
    expect((await store.getEvent(e.id))?.promoterIds).toEqual([p.id]);
    await store.updateEvent(e.id, { promoterIds: [] });
    expect((await store.getEvent(e.id))?.promoterIds).toEqual([]);
  });

  it("migration 037: an event's code count round-trips; a row from before it reads as null (no derivable code)", async () => {
    const e = event({ codeSeq: 0 });
    await store.createEvent(e);
    expect((await store.getEvent(e.id))?.codeSeq).toBe(0);
    await store.updateEvent(e.id, { codeSeq: 3, codeHash: `h-${randomUUID()}` });
    expect((await store.getEvent(e.id))?.codeSeq).toBe(3);
    await query(`UPDATE host_events SET code_seq = NULL WHERE id = $1`, [e.id]);
    expect((await store.getEvent(e.id))?.codeSeq).toBeNull();
  });

  it("migration 038: invites round-trip, are used once, revoke; an agreement can be absent until the person agrees", async () => {
    const t = Date.now();
    const inv = { id: randomUUID(), tokenHash: `t-${randomUUID()}`, displayName: "Sister Jensen", hostType: "sensitive" as const, organisation: "Riverside Ward", createdAt: t, expiresAt: t + 1000, usedAt: null, personId: null, revokedAt: null };
    await store.createInvite(inv);
    expect(await store.inviteByHash(inv.tokenHash)).toEqual(inv);
    expect((await store.listInvites()).some((i) => i.id === inv.id)).toBe(true);
    const p = person({ agreementVersion: null, agreementAt: null, hostType: "sensitive" });
    expect(await store.createPerson(p)).toBe(true);
    expect((await store.getPerson(p.id))?.agreementAt).toBeNull();
    expect(await store.useInvite(inv.id, p.id, t + 5)).toBe(true);
    expect(await store.useInvite(inv.id, p.id, t + 6)).toBe(false);
    expect(await store.inviteByHash(inv.tokenHash)).toMatchObject({ usedAt: t + 5, personId: p.id });
    await store.updatePerson(p.id, { agreementVersion: "host-terms-x", agreementAt: t + 7 });
    expect(await store.getPerson(p.id)).toMatchObject({ agreementVersion: "host-terms-x", agreementAt: t + 7 });
    const other = { ...inv, id: randomUUID(), tokenHash: `t-${randomUUID()}` };
    await store.createInvite(other);
    await store.updateInvite(other.id, { revokedAt: t + 9 });
    expect((await store.inviteByHash(other.tokenHash))?.revokedAt).toBe(t + 9);
    await expect(query(`INSERT INTO host_invites (id, token_hash, display_name, host_type, created_at, expires_at) VALUES ($1, $2, 'x', 'wizard', 1, 2)`, [randomUUID(), randomUUID()])).rejects.toThrow();
  });
});
