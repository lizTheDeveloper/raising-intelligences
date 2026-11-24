import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { logger } from "../src/logger.js";

/**
 * Host tools, prototype PR 1: Liz's admin (ceilings §9.1, a code shown once),
 * RI_MEETUP_CODES as studio events, the card before the pass, the host who
 * never plays (H12), and the unlinked "came with someone you know?" game.
 */

const ALICE = "@alice:multiversegames.ai";
const BOB = "@bob:multiversegames.ai";
const DEV = "@dev:multiversegames.ai";
const JENSEN = "@jensen:multiversegames.ai";
const DAY = 24 * 3600 * 1000;

describe("host tools admin and entry", () => {
  let h: HostHarness;
  beforeEach(async () => { h = await new HostHarness().boot(); });
  afterEach(async () => { await h.close(); vi.restoreAllMocks(); });

  it("admin routes need the admin token", async () => {
    expect((await h.get("/admin/host-tools/events")).status).toBe(401);
    expect((await h.post("/admin/host-tools/hosts", { matrixId: DEV, displayName: "Dev", hostType: "club" })).status).toBe(401);
  });

  it("a host must have passed the 18+ check; only the subject is stored, never the Matrix id", async () => {
    const r = await h.post("/admin/host-tools/hosts", { matrixId: DEV, displayName: "Dev", hostType: "club" }, ADMIN);
    expect(r.status).toBe(409);
    await h.verify(DEV);
    const ok = await h.post("/admin/host-tools/hosts", { matrixId: DEV, displayName: "Dev", hostType: "club" }, ADMIN);
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain(DEV);
    expect(ok.body.subject).toBeUndefined();
    expect(JSON.stringify([...(h.repo.hosts as any).people.values()])).not.toContain("@dev");
    expect((await h.post("/admin/host-tools/hosts", { matrixId: DEV, displayName: "Dev again", hostType: "club" }, ADMIN)).status).toBe(409);
  });

  it("the event code is returned once, at creation, and never again (not even its hash)", async () => {
    const e = await h.event({ name: "tuesday tea" });
    expect(e.code).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/);
    expect(e.body.event.codeHash).toBeUndefined();
    const list = await h.get("/admin/host-tools/events", ADMIN);
    expect(list.text).not.toContain(e.code);
    expect(list.text).not.toContain((h.repo.hosts as any).events.get(e.id).codeHash);
    expect(JSON.stringify([...(h.repo.hosts as any).events.values()])).not.toContain(e.code);
  });

  it("§9.1 ceilings: what each answer allows", async () => {
    const dev = await h.person(DEV, "Dev");
    const jensen = await h.person(JENSEN, "Sister Jensen");
    const t = Date.now();
    const make = (body: Record<string, unknown>) =>
      h.post("/admin/host-tools/events", { name: "x", opensAt: t, closesAt: t + DAY, ...body }, ADMIN);
    // Authority over attendees: L1 at most, never a share code.
    expect((await make({ kind: "outside", hostPersonId: dev, level: 3, authority: true })).status).toBe(400);
    expect((await make({ kind: "outside", hostPersonId: dev, level: 1, authority: true })).status).toBe(200);
    // A dating or events business can't host (until Q8a); it may promote a studio event, exchange off.
    expect((await make({ kind: "outside", hostPersonId: dev, level: 0, eventsBusiness: true })).status).toBe(400);
    expect((await make({ kind: "studio", level: 0, eventsBusiness: true, handleExchange: true })).status).toBe(400);
    const promoted = await make({ kind: "studio", level: 0, eventsBusiness: true });
    expect(promoted.status).toBe(200);
    expect(promoted.body.event.handleExchange).toBe(false);
    // A sensitive community can't host; its member can be a guest reader at a studio event.
    expect((await make({ kind: "outside", hostPersonId: jensen, level: 1, sensitive: true })).status).toBe(400);
    expect((await make({ kind: "studio", level: 3, guestReaderId: jensen })).status).toBe(200);
    // Structure: studio events have no outside host; guest readers only at studio L3; learning only at studio events.
    expect((await make({ kind: "studio", level: 0, hostPersonId: dev })).status).toBe(400);
    expect((await make({ kind: "studio", level: 3 })).status).toBe(400);
    expect((await make({ kind: "outside", hostPersonId: dev, level: 3, guestReaderId: jensen })).status).toBe(400);
    expect((await make({ kind: "outside", hostPersonId: dev, level: 1, studioLearning: true })).status).toBe(400);
    // A suspended person can't be attached to a new event.
    await h.post(`/admin/host-tools/hosts/${dev}/status`, { status: "suspended" }, ADMIN);
    expect((await make({ kind: "outside", hostPersonId: dev, level: 0 })).status).toBe(400);
  });

  it("share codes need RI_SHARE_CODE_SECRET; without it the event refuses to open", async () => {
    const jensen = await h.person(JENSEN, "Sister Jensen");
    const e = await h.event({ kind: "studio", level: 3, guestReaderId: jensen });
    expect((await h.card(e.code)).status).toBe(200);
    h.hostCfg = { ...h.hostCfg, shareCodeSecret: null };
    expect((await h.card(e.code)).text).toBe((await h.get("/never-built-path")).text);
    const t = Date.now();
    const r = await h.post("/admin/host-tools/events", { name: "x", kind: "studio", level: 3, guestReaderId: jensen, opensAt: t, closesAt: t + DAY }, ADMIN);
    expect(r.status).toBe(409);
  });

  it("the card comes before the pass: no acknowledgement, no pass", async () => {
    const e = await h.event({});
    await h.verify(ALICE);
    const noAck = await h.post("/stranger/pass", { openIdToken: `tok:${ALICE}`, meetup: e.code });
    expect(noAck.status).toBe(409);
    expect(noAck.body.error).toBe("Please read the meetup card first.");
    expect(noAck.body.card.eventName).toBe("tuesday tea");
    // Someone else's acknowledgement token, already bound to them, doesn't count for Alice.
    await h.verify(BOB);
    const c = (await h.card(e.code)).body.card;
    const bobAck = (await h.post("/events/ack", { meetup: e.code, cardVersion: c.version })).body.ackToken;
    expect((await h.post("/stranger/pass", { openIdToken: `tok:${BOB}`, meetup: e.code, ackToken: bobAck })).status).toBe(200);
    expect((await h.post("/stranger/pass", { openIdToken: `tok:${ALICE}`, meetup: e.code, ackToken: bobAck })).status).toBe(409);
    expect(typeof (await h.arrive(ALICE, e.code))).toBe("string");
  });

  it("the queue respects pause, the opening time and capacity", async () => {
    const e = await h.event({ capacity: 1 });
    const a = await h.arrive(ALICE, e.code);
    const b = await h.arrive(BOB, e.code);
    await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { paused: true }, ADMIN);
    expect((await h.queue(a)).status).toBe(409);
    await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { paused: false }, ADMIN);
    expect((await h.queue(a)).status).toBe(200);
    const full = await h.queue(b);
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("this meetup is full.");
    expect((await h.queue(a)).status).toBe(200); // already in: still fine
    const later = await h.event({ opensAt: Date.now() + DAY, closesAt: Date.now() + 2 * DAY });
    expect((await h.card(later.code)).body.card.status).toBe("not_open_yet");
    const c = await h.arrive("@carol:multiversegames.ai", later.code);
    expect((await h.queue(c)).status).toBe(409);
  });

  it("H12: the host and the guest reader are refused at the queue, with the neutral copy", async () => {
    const dev = await h.person(DEV, "Dev");
    const jensen = await h.person(JENSEN, "Sister Jensen");
    const outside = await h.event({ kind: "outside", level: 1, hostPersonId: dev, handleExchange: false });
    const studio = await h.event({ kind: "studio", level: 3, guestReaderId: jensen });
    const devPass = await h.arrive(DEV, outside.code);
    const r = await h.queue(devPass);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("stranger mode isn't available here.");
    const jensenPass = await h.arrive(JENSEN, studio.code);
    const g = await h.queue(jensenPass);
    expect(g.status).toBe(403);
    expect(g.body.error).toBe("stranger mode isn't available here.");
    // At someone else's event, Dev is an ordinary player.
    expect((await h.queue(await h.arrive(DEV, studio.code))).status).toBe(200);
  });

  it("H12: a guest reader made after the match is refused at JOIN_GAME", async () => {
    const e = await h.event({});
    const { gameId, pa, ma } = await h.pair(e.code);
    // Alice's seat: a later admin attaches her as a guest reader of this event? Not allowed after the
    // first acknowledgement — so go under the store, as a bug would, and check JOIN_GAME holds the line.
    const alice = await h.person(ALICE, "Alice");
    await h.repo.hosts.updateEvent(e.id, { guestReaderId: alice, level: 3, shareCodes: true });
    await (h.hosts as any).init();
    const c = await h.client();
    const err = c.once<{ error: string }>(E.ERROR);
    c.emit(E.JOIN_GAME, { gameId, playerToken: ma.playerToken, strangerPass: pa });
    expect((await err).error).toBe("This game is private.");
  });

  it("RI_MEETUP_CODES: a listed code is a studio L0 event with a card, and the old flow works after it", async () => {
    await h.close();
    h = await new HostHarness({ stranger: { meetupCodes: new Set(["tea-party"]) } }).boot();
    const card = await h.card("tea-party");
    expect(card.status).toBe(200);
    expect(card.body.card.hostLine).toBe("run by the studio that makes raising intelligences.");
    expect(JSON.stringify(card.body.card)).toContain("if you both say yes, you'll each see the other's multiversegames.ai username");
    const env = [...(h.repo.hosts as any).events.values()];
    expect(env).toHaveLength(1);
    expect(env[0].source).toBe("env");
    expect(env[0].closesAt - env[0].opensAt).toBeLessThanOrEqual(14 * DAY);
    // Status (the old door) still answers for the code.
    expect((await h.get("/stranger/status?meetup=tea-party")).body.visible).toBe(true);
    const { gameId } = await h.pair("tea-party");
    const run = await h.repo.stranger.getRun(gameId);
    expect(run?.eventId).toBe(env[0].id);
    expect(run?.meetupCode).toBeNull(); // the code itself isn't stored with the game
  });

  it("came together: an invite game started after the card has no link to the event, anywhere", async () => {
    const e = await h.event({});
    const logged: string[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation((...a: unknown[]) => { logged.push(JSON.stringify(a)); });
    }
    await h.card(e.code);
    await h.post("/events/ack", { meetup: e.code, cardVersion: 1 });
    // "start an invite game": the ordinary CREATE_GAME, with no meetup field.
    const c = await h.client();
    const joined = c.once<{ gameId: string }>(E.JOINED);
    c.emit(E.CREATE_GAME, { childName: "Pip", displayName: "Ash" });
    const { gameId } = await joined;
    expect(await h.repo.stranger.getRun(gameId)).toBeNull();
    const hostsDump = JSON.stringify({
      ...Object.fromEntries(Object.entries(h.repo.hosts as any).map(([k, v]) => [k, v instanceof Map ? [...v.values()] : v])),
    });
    expect(hostsDump).not.toContain(gameId);
    expect(logged.join("\n")).not.toContain(e.code);
    expect(h.built.games.get(gameId)?.relationshipType).not.toBe("co-parents who were never together");
  });

  it("H21: across card, ack, pass, queue, match, seats, report-host and admin, no log line carries the event code", async () => {
    const SENTINEL = "zebra-quartz-lantern-ozone";
    await h.close();
    const logged: string[] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation((...a: unknown[]) => { logged.push(JSON.stringify(a)); });
    }
    h = await new HostHarness({ stranger: { meetupCodes: new Set([SENTINEL]) } }).boot();
    const e = await h.event({});
    await h.pair(SENTINEL);
    await h.pair(e.code, "@c:multiversegames.ai", "@d:multiversegames.ai");
    await h.post("/events/report-host", { meetup: SENTINEL, text: "x" });
    await h.post("/events/ack", { meetup: SENTINEL, cardVersion: 99 });
    await h.get(`/stranger/status?meetup=${SENTINEL}`);
    const admin = await h.get("/admin/host-tools/events", ADMIN);
    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join("\n");
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain(e.code);
    expect(admin.text).not.toContain(SENTINEL);
    expect(JSON.stringify([...(h.repo.hosts as any).events.values()])).not.toContain(SENTINEL);
    expect(JSON.stringify([...(h.repo.stranger as any).runs.values()])).not.toContain(SENTINEL);
  });
});
