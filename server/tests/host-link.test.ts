import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";

/**
 * Persona tests, Kofi (board-games club): "I can't see the link I'm supposed
 * to hand out, I can't see what my members were told."
 *
 * - The portal shows the host their own meetup link, again, whenever they
 *   ask. The code is derived from the server's pepper and the event's id and
 *   a rotation count (like a share code's words), so it is never stored in
 *   the clear. An event made before this has a random code nobody kept: it
 *   shows "get a new link" instead.
 * - A preview of the card exactly as players see it, read-only.
 * - "get a new link": the old code stops at once (anyone still on the card
 *   gets the neutral ending); anyone already past the card, queued or
 *   playing, carries on.
 */

const KOFI = "@kofi:multiversegames.ai";
const ROBIN = "@robin:multiversegames.ai";
const READER = "@reader:multiversegames.ai";

describe("the host's link, card preview and new link", () => {
  let h: HostHarness;
  let kofi: string;
  beforeEach(async () => {
    h = await new HostHarness().boot();
    kofi = await h.person(KOFI, "Kofi", { hostType: "club" });
  });
  afterEach(async () => { await h.close(); });

  const pass = async (mxid = KOFI) => (await h.post("/host/pass", { openIdToken: `tok:${mxid}` })).body.pass as string;
  const refOf = async (p: string, name: string) => ((await h.post("/host/events", { pass: p })).body.events as any[]).find((e) => e.name === name)?.ref as string;

  it("the portal shows the host the link the admin was given, again", async () => {
    const e = await h.event({ kind: "outside", level: 1, hostPersonId: kofi, name: "club night" });
    const p = await pass();
    const ref = await refOf(p, "club night");
    const r = await h.post(`/host/events/${ref}/link`, { pass: p });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(e.code);
    expect(r.body.link).toMatch(new RegExp(`/\\?meetup=${e.code}$`));
    // The same again: nothing changes by looking.
    expect((await h.post(`/host/events/${ref}/link`, { pass: p })).body.code).toBe(e.code);
    expect((await h.card(e.code)).status).toBe(200);
  });

  it("only the event's host: never its guest reader, another host, or anyone signed out", async () => {
    await h.person(READER, "Reader", { hostType: "studio" });
    const robin = await h.person(ROBIN, "Robin", { hostType: "club" });
    await h.event({ kind: "outside", level: 1, hostPersonId: kofi, name: "club night" });
    await h.event({ kind: "outside", level: 1, hostPersonId: robin, name: "robin's night" });
    const ref = await refOf(await pass(), "club night");
    for (const path of ["link", "card", "new-link"]) {
      expect((await h.post(`/host/events/${ref}/${path}`, { pass: await pass(ROBIN) })).status).toBe(404);
      expect((await h.post(`/host/events/${ref}/${path}`, { pass: "nope" })).status).toBe(401);
    }
  });

  it("the card preview is exactly the card players are shown", async () => {
    const e = await h.event({ kind: "outside", level: 1, hostPersonId: kofi, name: "club night", welcomeText: "bring snacks." });
    const p = await pass();
    const ref = await refOf(p, "club night");
    const preview = await h.post(`/host/events/${ref}/card`, { pass: p });
    expect(preview.status).toBe(200);
    expect(preview.body.card).toEqual((await h.card(e.code)).body.card);
    // After the first acknowledgement the frozen card is still what players see.
    await h.arrive("@ann:multiversegames.ai", e.code);
    await h.post(`/host/events/${ref}/lower`, { pass: p });
    const after = await h.post(`/host/events/${ref}/card`, { pass: p });
    expect(after.body.card).toEqual((await h.card(e.code)).body.card);
    expect(after.body.card.version).toBe(2);
  });

  it("a new link: the old code stops at once, the new one works, and people already past the card carry on", async () => {
    const e = await h.event({ kind: "outside", level: 1, hostPersonId: kofi, name: "club night", handleExchange: false });
    const p = await pass();
    const ref = await refOf(p, "club night");
    // A pair already playing, someone queued, and someone still reading the card.
    const seated = await h.pair(e.code, "@a:multiversegames.ai", "@b:multiversegames.ai");
    const queued = await h.arrive("@q:multiversegames.ai", e.code);
    expect((await h.queue(queued)).status).toBe(200);
    await h.verify("@mid:multiversegames.ai");
    const midIp = h.ipFor("@mid:multiversegames.ai");
    const midCard = await h.get(`/events/card?meetup=${e.code}`, midIp);
    expect(midCard.status).toBe(200);

    const r = await h.post(`/host/events/${ref}/new-link`, { pass: p });
    expect(r.status).toBe(200);
    expect(r.body.code).not.toBe(e.code);
    expect(r.body.link).toMatch(new RegExp(`\\?meetup=${r.body.code}$`));
    expect((await h.post(`/host/events/${ref}/link`, { pass: p })).body.code).toBe(r.body.code);

    // The old code: the never-built answer, everywhere, like a closed meetup.
    const never = (await h.get("/never-built-path")).text;
    expect((await h.card(e.code)).text).toBe(never);
    const ack = await h.post("/events/ack", { meetup: e.code, cardVersion: midCard.body.card.version }, midIp);
    expect(ack.text).toBe(never);
    // The new code: the same meetup, the same card.
    const fresh = await h.card(r.body.code);
    expect(fresh.status).toBe(200);
    expect(fresh.body.card).toEqual(midCard.body.card);

    // Queued before the change: still waiting, and matched with someone who came by the new link.
    const poll = await h.post("/stranger/queue/poll", { pass: queued }, h.ipFor(queued));
    expect(poll.status).toBe(200);
    const late = await h.arrive("@late:multiversegames.ai", r.body.code);
    await h.queue(late);
    const m = (await h.post("/stranger/queue/poll", { pass: queued }, h.ipFor(queued))).body;
    expect(m.status).toBe("matched");

    // Playing before the change: a reconnect still takes the seat.
    const c = await h.client();
    const state = c.waitFor<ViewerState>(E.STATE);
    c.emit(E.JOIN_GAME, { gameId: seated.gameId, playerToken: seated.ma.playerToken, strangerPass: seated.pa });
    expect((await state).phase).toBeTruthy();
  });

  it("an event from before derived codes has no link to show until the host asks for a new one", async () => {
    await h.event({ kind: "outside", level: 1, hostPersonId: kofi, name: "old night" });
    const id = h.hosts.listCached().find((x) => x.name === "old night")!.id;
    // As migration 037 leaves an existing row: a random code, kept by nobody.
    h.hosts.refresh((await h.repo.hosts.updateEvent(id, { codeSeq: null }))!);
    const p = await pass();
    const ref = await refOf(p, "old night");
    const r = await h.post(`/host/events/${ref}/link`, { pass: p });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ link: null, code: null });
    const n = await h.post(`/host/events/${ref}/new-link`, { pass: p });
    expect(n.status).toBe(200);
    expect((await h.card(n.body.code)).status).toBe(200);
  });

  it("a closed meetup has no link and no new link", async () => {
    await h.event({ kind: "outside", level: 1, hostPersonId: kofi, name: "club night" });
    const p = await pass();
    const ref = await refOf(p, "club night");
    await h.post(`/host/events/${ref}/close`, { pass: p });
    expect((await h.post(`/host/events/${ref}/link`, { pass: p })).status).toBe(409);
    expect((await h.post(`/host/events/${ref}/new-link`, { pass: p })).status).toBe(409);
    // The card preview still works: it's what players were told.
    expect((await h.post(`/host/events/${ref}/card`, { pass: p })).status).toBe(200);
  });

  it("the admin can see and replace any event's link too", async () => {
    const e = await h.event({ kind: "studio", level: 0, name: "studio night" });
    const seen = await h.get(`/admin/host-tools/events/${e.id}/link`, ADMIN);
    expect(seen.body.code).toBe(e.code);
    const r = await h.post(`/admin/host-tools/events/${e.id}/new-link`, {}, ADMIN);
    expect(r.status).toBe(200);
    expect((await h.card(e.code)).status).not.toBe(200);
    expect((await h.card(r.body.code)).status).toBe(200);
    expect((await h.get(`/admin/host-tools/events/${e.id}/link`)).status).toBe(401);
  });
});
