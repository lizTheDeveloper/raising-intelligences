import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { openFirstScene, submitPersonalities } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { reconcileTerms } from "../src/hosts/card.js";

/**
 * B6 / H17: the card's computed lines are frozen at the first
 * acknowledgement, the event keeps its card's terms, a change in the player's
 * favour applies at once, and a stale card is shown again before the next step.
 */

const DAY = 24 * 3600 * 1000;

describe("frozen terms", () => {
  let h: HostHarness;
  beforeEach(async () => { h = await new HostHarness({ paywallOn: false }).boot(); h.mock.events = h.events(4); });
  afterEach(async () => { await h.close(); });

  it("B6: a card that said free stays free after the paywall is switched on — no checkout, nothing due", async () => {
    const e = await h.event({});
    const { A, B, gameId } = await h.pair(e.code);
    h.paywall = { ...h.paywall, switchOn: true };
    expect(h.built.payments.active()).toBe(true);
    const scene = await openFirstScene(A, B);
    expect(scene.payment).toBeNull();
    expect(await h.repo.partnerPayments.get(gameId)).toBeNull();
    // The card served to a new player still shows the frozen cost.
    expect(JSON.stringify((await h.card(e.code)).body.card)).toContain("it's free at this meetup.");
  });

  it("control: a card frozen with the paywall on charges as before", async () => {
    h.paywall = { ...h.paywall, switchOn: true };
    const e = await h.event({});
    expect(JSON.stringify((await h.card(e.code)).body.card)).toContain("$20 per child, paid once by whoever is paired first");
    const { A, B, gameId } = await h.pair(e.code);
    const due = A.waitFor<{ payment: { status: string } | null }>(E.STATE, (s) => s.payment?.status === "due");
    submitPersonalities(A, B);
    await due;
    expect((await h.repo.partnerPayments.get(gameId))?.status).toBe("due");
  });

  it("H17: after the first acknowledgement only pause, close and a lower level can change", async () => {
    const e = await h.event({ name: "before" });
    // Before anyone acknowledged: anything (within the ceilings).
    expect((await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { name: "renamed" }, ADMIN)).status).toBe(200);
    await h.arrive("@alice:multiversegames.ai", e.code);
    for (const patch of [{ name: "x" }, { handleExchange: false }, { welcomeText: "hi" }, { closesAt: Date.now() + DAY }, { capacity: 3 }]) {
      const r = await h.req("PATCH", `/admin/host-tools/events/${e.id}`, patch, ADMIN);
      expect(r.status, JSON.stringify(patch)).toBe(409);
    }
    expect((await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { paused: true }, ADMIN)).status).toBe(200);
    expect((await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { paused: false }, ADMIN)).status).toBe(200);
  });

  it("H17: lowering the level bumps the card version; a stale player gets the new card at pass and at queue join", async () => {
    const dev = await h.person("@dev:multiversegames.ai", "Dev");
    const e = await h.event({ kind: "outside", level: 3, hostPersonId: dev, handleExchange: false });
    const queued = await h.arrive("@alice:multiversegames.ai", e.code);
    // Bob read version 1 and pressed continue, but hasn't signed in yet.
    await h.verify("@bob:multiversegames.ai");
    const v1 = (await h.card(e.code)).body.card;
    const bobAck = (await h.post("/events/ack", { meetup: e.code, cardVersion: v1.version })).body.ackToken;
    const lowered = await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { level: 1 }, ADMIN);
    expect(lowered.status).toBe(200);
    expect(lowered.body.event.cardVersion).toBe(2);
    expect((await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { level: 3 }, ADMIN)).status).toBe(409);
    // At the pass: 409 with the new card.
    const pass = await h.post("/stranger/pass", { openIdToken: "tok:@bob:multiversegames.ai", meetup: e.code, ackToken: bobAck });
    expect(pass.status).toBe(409);
    expect(pass.body.card.version).toBe(2);
    expect(JSON.stringify(pass.body.card)).not.toContain("share code");
    // An old version at /events/ack: 409 with the new card too.
    const stale = await h.post("/events/ack", { meetup: e.code, cardVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.card.version).toBe(2);
    // At the queue: Alice signed in under version 1.
    const join = await h.queue(queued);
    expect(join.status).toBe(409);
    expect(join.body.error).toBe("this meetup's card changed. here's the new one.");
    expect(join.body.card.version).toBe(2);
    // She reads the new card (signed in: bound at once) and joins.
    expect((await h.post("/events/ack", { meetup: e.code, cardVersion: 2, pass: queued })).status).toBe(200);
    expect((await h.queue(queued)).status).toBe(200);
  });

  it("H17: a shorter trace retention applies at once and bumps the version; a longer one closes the event", async () => {
    h.hostCfg = { ...h.hostCfg, traceRetentionDays: 60 };
    const e = await h.event({});
    await h.arrive("@alice:multiversegames.ai", e.code);
    expect(JSON.stringify((await h.card(e.code)).body.card)).toContain("for 60 days, then deleted");
    h.hostCfg = { ...h.hostCfg, traceRetentionDays: 30 };
    await h.hosts.reconcileAll();
    const { card } = (await h.card(e.code)).body;
    expect(card.version).toBe(2);
    expect(JSON.stringify(card)).toContain("for 30 days, then deleted");
    h.hostCfg = { ...h.hostCfg, traceRetentionDays: 90 };
    await h.hosts.reconcileAll();
    expect((await h.card(e.code)).text).toBe((await h.get("/never-built-path")).text);
  });

  it("reconcileTerms: favourable changes update, unhonourable ones close, a free card stays free", () => {
    const base = { cost: "free" as const, traceRetentionDays: null, traceWhere: "studio" as const, handleExchange: true, learning: false };
    expect(reconcileTerms(base, { paywallOn: true, traceRetentionDays: null, traceWhere: "studio" })).toEqual({ action: "keep" });
    expect(reconcileTerms({ ...base, cost: "first_parent" }, { paywallOn: false, traceRetentionDays: null, traceWhere: "studio" }))
      .toEqual({ action: "update", terms: base });
    expect(reconcileTerms(base, { paywallOn: false, traceRetentionDays: null, traceWhere: "langfuse_cloud" }).action).toBe("close");
    expect(reconcileTerms({ ...base, traceRetentionDays: 30 }, { paywallOn: false, traceRetentionDays: null, traceWhere: "studio" }).action).toBe("close");
  });

  it("H17: an event ends within 14 days of opening", async () => {
    const t = Date.now();
    const r = await h.post("/admin/host-tools/events", { name: "long", kind: "studio", level: 0, opensAt: t, closesAt: t + 15 * DAY }, ADMIN);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("14 days");
  });

  describe("RI_MEETUP_CODES periods", () => {
    let e: HostHarness;
    beforeEach(async () => {
      e = await new HostHarness({ paywallOn: false, clock: Date.now(), stranger: { meetupCodes: new Set(["tea-party"]) } }).boot();
      e.mock.events = e.events(4);
    });
    afterEach(async () => { await e.close(); });

    it("a free card frozen in one period doesn't carry into the next: after the roll, a new player sees and accepts the live (paid) terms", async () => {
      await e.arrive("@alice:multiversegames.ai", "tea-party");
      expect(JSON.stringify((await e.card("tea-party")).body.card)).toContain("it's free at this meetup.");
      e.clock!.now += 15 * DAY;
      e.paywall = { ...e.paywall, switchOn: true };
      const c = (await e.card("tea-party")).body.card;
      expect(JSON.stringify(c)).toContain("$20 per child, paid once by whoever is paired first");
      expect(JSON.stringify(c)).not.toContain("it's free at this meetup.");
      const events = [...(e.repo.hosts as any).events.values()];
      expect(events).toHaveLength(2);
      const fresh = events.find((x: any) => x.closedAt === null);
      expect(fresh.frozenTerms).toBeNull();
      await e.arrive("@carol:multiversegames.ai", "tea-party");
      expect((await e.repo.hosts.getEvent(fresh.id))?.frozenTerms?.cost).toBe("first_parent");
      // The old period keeps what it froze.
      const old = events.find((x: any) => x.closedAt !== null);
      expect((await e.repo.hosts.getEvent(old.id))?.frozenTerms?.cost).toBe("free");
      // A period-1 acknowledgement isn't current for period 2.
      const stale = await e.post("/stranger/pass", { openIdToken: "tok:@alice:multiversegames.ai", meetup: "tea-party" });
      expect(stale.status).toBe(409);
    });

    it("a game started under a free card stays free when it carries on after the roll and the paywall comes on", async () => {
      const { A, B, gameId } = await e.pair("tea-party");
      e.clock!.now += 15 * DAY;
      expect((await e.card("tea-party")).status).toBe(200); // the roll
      e.paywall = { ...e.paywall, switchOn: true };
      const scene = await openFirstScene(A, B);
      expect(scene.payment).toBeNull();
      expect(await e.repo.partnerPayments.get(gameId)).toBeNull();
      expect(await e.built.payments.owes(gameId)).toBe(false);
    });

    it("a player queued in one period never pairs with one from the next", async () => {
      const a = await e.arrive("@alice:multiversegames.ai", "tea-party");
      expect((await e.queue(a)).status).toBe(200);
      e.clock!.now += 15 * DAY;
      e.paywall = { ...e.paywall, switchOn: true };
      const c = await e.arrive("@carol:multiversegames.ai", "tea-party");
      expect((await e.queue(c)).status).toBe(200);
      const poll = (await e.post("/stranger/queue/poll", { pass: c }, e.ipFor(c))).body;
      expect(poll.status).not.toBe("matched");
    });
  });
});
