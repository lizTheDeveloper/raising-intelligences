import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";

/**
 * Persona tests, Dev (Spark Night): the §9.1 ceiling lives on the PERSON,
 * not on a per-event checkbox, and a promoter never plays at the event they
 * promoted.
 *
 * - The host type is set once by the admin (club, authority, events business,
 *   sensitive, studio). Every event's allowed levels and naming derive from
 *   it, so leaving a box unticked can't give "Dev (Spark Night)" an outside
 *   L0 event under his own name.
 * - A promoter role on events: refused at the queue and at JOIN_GAME exactly
 *   like a host (H12), with the same neutral refusal.
 */

const DEV = "@dev:multiversegames.ai";
const JENSEN = "@jensen:multiversegames.ai";
const KOFI = "@kofi:multiversegames.ai";
const TEACH = "@teach:multiversegames.ai";
const STAFF = "@staff:multiversegames.ai";
const DAY = 24 * 3600 * 1000;
const NEUTRAL = "stranger mode isn't available here.";

describe("host type and promoters", () => {
  let h: HostHarness;
  beforeEach(async () => { h = await new HostHarness().boot(); });
  afterEach(async () => { await h.close(); });

  const make = (body: Record<string, unknown>) => {
    const t = Date.now();
    return h.post("/admin/host-tools/events", { name: "friday singles night", opensAt: t - 1000, closesAt: t + DAY, ...body }, ADMIN);
  };

  it("the host type is required when a person is added, and comes back on the person", async () => {
    await h.verify(DEV);
    const none = await h.post("/admin/host-tools/hosts", { matrixId: DEV, displayName: "Dev (Spark Night)" }, ADMIN);
    expect(none.status).toBe(400);
    expect(none.body.error).toContain("host type");
    const bad = await h.post("/admin/host-tools/hosts", { matrixId: DEV, displayName: "Dev", hostType: "wizard" }, ADMIN);
    expect(bad.status).toBe(400);
    const ok = await h.post("/admin/host-tools/hosts", { matrixId: DEV, displayName: "Dev (Spark Night)", hostType: "events_business", organisation: "Spark Night" }, ADMIN);
    expect(ok.status).toBe(200);
    expect(ok.body.hostType).toBe("events_business");
    expect(ok.body.organisation).toBe("Spark Night");
    const list = await h.get("/admin/host-tools/hosts", ADMIN);
    expect(list.body.people[0].hostType).toBe("events_business");
  });

  it("an events business can't host an outside event, ticked or not (Dev's finding 7)", async () => {
    const dev = await h.person(DEV, "Dev (Spark Night)", { hostType: "events_business", organisation: "Spark Night" });
    for (const level of [0, 1, 3]) {
      const r = await make({ kind: "outside", level, hostPersonId: dev, handleExchange: false });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("dating or events business");
    }
  });

  it("authority over attendees comes from the person: L1 at most, and the event records it", async () => {
    const teach = await h.person(TEACH, "Ms Ray", { hostType: "authority" });
    const l3 = await make({ kind: "outside", level: 3, hostPersonId: teach, handleExchange: false });
    expect(l3.status).toBe(400);
    expect(l3.body.error).toContain("authority");
    const l1 = await make({ kind: "outside", level: 1, hostPersonId: teach });
    expect(l1.status).toBe(200);
    expect(l1.body.event.authority).toBe(true);
    // And it can't be raised to share codes later, not even before the first acknowledgement.
    expect((await h.req("PATCH", `/admin/host-tools/events/${l1.body.event.id}`, { level: 3 }, ADMIN)).status).toBe(400);
  });

  it("a club hosts at any level; a sensitive-community counsellor or studio staff can't host, but can read for a studio event", async () => {
    const kofi = await h.person(KOFI, "Kofi", { hostType: "club" });
    expect((await make({ kind: "outside", level: 3, hostPersonId: kofi, handleExchange: false })).status).toBe(200);
    const jensen = await h.person(JENSEN, "Sister Jensen", { hostType: "sensitive" });
    const host = await make({ kind: "outside", level: 1, hostPersonId: jensen });
    expect(host.status).toBe(400);
    expect(host.body.error).toContain("guest reader");
    expect((await make({ kind: "studio", level: 3, guestReaderId: jensen })).status).toBe(200);
    const staff = await h.person(STAFF, "Robin", { hostType: "studio" });
    expect((await make({ kind: "outside", level: 1, hostPersonId: staff })).status).toBe(400);
    expect((await make({ kind: "studio", level: 3, guestReaderId: staff })).status).toBe(200);
  });

  it("an events business or a person with authority is never a guest reader", async () => {
    const dev = await h.person(DEV, "Dev", { hostType: "events_business" });
    const teach = await h.person(TEACH, "Ms Ray", { hostType: "authority" });
    expect((await make({ kind: "studio", level: 3, guestReaderId: dev })).status).toBe(400);
    expect((await make({ kind: "studio", level: 3, guestReaderId: teach })).status).toBe(400);
  });

  it("a person from before host types can't be put on a new event until the admin sets their type, once", async () => {
    const legacy = await h.person(KOFI, "Kofi", { hostType: "club" });
    await h.repo.hosts.updatePerson(legacy, { hostType: null });
    const r = await make({ kind: "outside", level: 1, hostPersonId: legacy });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("host type");
    expect((await h.post(`/admin/host-tools/hosts/${legacy}/type`, { hostType: "club" }, ADMIN)).status).toBe(200);
    const ok = await make({ kind: "outside", level: 1, hostPersonId: legacy });
    expect(ok.status).toBe(200);
    // Set once: while they're on an event that isn't closed, the type stays.
    const change = await h.post(`/admin/host-tools/hosts/${legacy}/type`, { hostType: "authority" }, ADMIN);
    expect(change.status).toBe(409);
  });

  it("an events business promoting a studio event: exchange off, and the card never names the business", async () => {
    const dev = await h.person(DEV, "Dev (Spark Night)", { hostType: "events_business", organisation: "Spark Night" });
    const named = await make({ kind: "studio", level: 0, promoterIds: [dev], name: "Spark Night presents: RI" });
    expect(named.status).toBe(400);
    expect(named.body.error).toContain("Spark Night");
    const welcome = await make({ kind: "studio", level: 0, promoterIds: [dev], welcomeText: "brought to you by spark night dating" });
    expect(welcome.status).toBe(400);
    expect((await make({ kind: "studio", level: 0, promoterIds: [dev], handleExchange: true })).status).toBe(400);
    const ok = await make({ kind: "studio", level: 0, promoterIds: [dev] });
    expect(ok.status).toBe(200);
    expect(ok.body.event.eventsBusiness).toBe(true);
    expect(ok.body.event.handleExchange).toBe(false);
    expect(ok.body.event.promoterIds).toEqual([dev]);
    // Only a studio event can be promoted by an events business.
    const kofi = await h.person(KOFI, "Kofi", { hostType: "club" });
    expect((await make({ kind: "outside", level: 1, hostPersonId: kofi, promoterIds: [dev], handleExchange: false })).status).toBe(400);
  });

  it("a promoter is refused at the queue with the neutral copy, and plays anywhere else (Dev's finding 6)", async () => {
    const dev = await h.person(DEV, "Dev (Spark Night)", { hostType: "events_business", organisation: "Spark Night" });
    const promoted = await h.event({ kind: "studio", level: 0, promoterIds: [dev] });
    const devPass = await h.arrive(DEV, promoted.code);
    const r = await h.queue(devPass);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(NEUTRAL);
    const other = await h.event({ kind: "studio", level: 0, name: "tuesday tea" });
    expect((await h.queue(await h.arrive(DEV, other.code))).status).toBe(200);
  });

  it("a promoter added after the match is refused at JOIN_GAME, like a host", async () => {
    const kofi = await h.person(KOFI, "Kofi", { hostType: "club" });
    const e = await h.event({ kind: "studio", level: 0 });
    const { gameId, pa, ma } = await h.pair(e.code, KOFI);
    const added = await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { promoterIds: [kofi] }, ADMIN);
    expect(added.status).toBe(200);
    const c = await h.client();
    const err = c.once<{ error: string }>(E.ERROR);
    c.emit(E.JOIN_GAME, { gameId, playerToken: ma.playerToken, strangerPass: pa });
    expect((await err).error).toBe("This game is private.");
  });

  it("the card says whoever sent the link can't play and sees nothing; adding a promoter later is a new card", async () => {
    const kofi = await h.person(KOFI, "Kofi", { hostType: "club" });
    const plain = await h.event({ kind: "studio", level: 0 });
    const before = (await h.card(plain.code)).body.card;
    expect(JSON.stringify(before)).not.toContain("sent you this link");
    await h.arrive("@ann:multiversegames.ai", plain.code); // first acknowledgement: terms frozen
    const r = await h.req("PATCH", `/admin/host-tools/events/${plain.id}`, { promoterIds: [kofi] }, ADMIN);
    expect(r.status).toBe(200);
    const after = (await h.card(plain.code)).body.card;
    expect(after.version).toBe(before.version + 1);
    expect(JSON.stringify(after)).toContain("the business or group that sent you this link can't play at this meetup, and sees nothing about who came or how it went.");
  });

  it("after the first acknowledgement, a promoter that would turn the handle exchange off is refused", async () => {
    const dev = await h.person(DEV, "Dev", { hostType: "events_business" });
    const e = await h.event({ kind: "studio", level: 0 });
    await h.arrive("@ann:multiversegames.ai", e.code);
    const r = await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { promoterIds: [dev] }, ADMIN);
    expect(r.status).toBe(409);
  });

  it("promoters see nothing in the portal", async () => {
    const dev = await h.person(DEV, "Dev", { hostType: "events_business" });
    await h.event({ kind: "studio", level: 0, promoterIds: [dev] });
    const pass = await h.post("/host/pass", { openIdToken: `tok:${DEV}` });
    expect(pass.status).toBe(200);
    const list = await h.post("/host/events", { pass: pass.body.pass });
    expect(list.status).toBe(200);
    expect(list.body.events).toEqual([]);
  });

  it("S3-6: a sensitive studio event says what to do instead", async () => {
    const r = await make({ kind: "studio", level: 0, sensitive: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("a studio event can't be for a sensitive community yet (Q4). leave this unticked if the event is open to anyone, and make the community's member a guest reader.");
  });
});
