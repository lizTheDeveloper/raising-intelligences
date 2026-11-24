import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { DECK } from "../src/hosts/portal.js";

/**
 * The host portal (spec §4, §B.3 /api/host/*): sign-in, the live status only,
 * one publication of the banded funnel a day after close, and nothing per pair.
 */

const DEV = "@dev:multiversegames.ai";
const JENSEN = "@jensen:multiversegames.ai";
const HOUR = 3600 * 1000;

describe("the host portal", () => {
  let h: HostHarness;
  beforeEach(async () => { h = await new HostHarness({ clock: Date.now() }).boot(); });
  afterEach(async () => { await h.close(); });

  const hostPass = async (mxid: string) => (await h.post("/host/pass", { openIdToken: `tok:${mxid}` }));

  it("only an approved host or guest reader gets a pass; everyone else gets the bad-token 401", async () => {
    const bad = await hostPass("@nobody:multiversegames.ai");
    expect(bad.status).toBe(401);
    const forged = await h.post("/host/pass", { openIdToken: "forged" });
    expect(forged.status).toBe(401);
    expect(bad.text).toBe(forged.text);
    const dev = await h.person(DEV, "Dev");
    expect((await hostPass(DEV)).status).toBe(200);
    await h.post(`/admin/host-tools/hosts/${dev}/status`, { status: "suspended" }, ADMIN);
    const suspended = await hostPass(DEV);
    expect(suspended.status).toBe(401);
    expect(suspended.text).toBe(forged.text);
  });

  it("a pass stops working when the person is suspended", async () => {
    const dev = await h.person(DEV, "Dev");
    const pass = (await hostPass(DEV)).body.pass;
    expect((await h.post("/host/events", { pass })).status).toBe(200);
    await h.post(`/admin/host-tools/hosts/${dev}/status`, { status: "suspended" }, ADMIN);
    expect((await h.post("/host/events", { pass })).status).toBe(401);
  });

  it("while open, a host sees only open / paused / closed / full; a guest reader sees name and dates only", async () => {
    const dev = await h.person(DEV, "Dev");
    const jensen = await h.person(JENSEN, "Sister Jensen");
    const outside = await h.event({ kind: "outside", level: 1, hostPersonId: dev, handleExchange: false, name: "dev's night" });
    await h.event({ kind: "studio", level: 3, guestReaderId: jensen, name: "studio night" });
    await h.pair(outside.code);
    const devView = (await h.post("/host/events", { pass: (await hostPass(DEV)).body.pass })).body;
    expect(devView.events).toHaveLength(1);
    expect(devView.events[0]).toMatchObject({ name: "dev's night", role: "host", status: "open", funnel: null });
    const flat = JSON.stringify(devView);
    expect(flat).not.toMatch(/joined|started|queued|games|count/i);
    const guestView = (await h.post("/host/events", { pass: (await hostPass(JENSEN)).body.pass })).body;
    expect(guestView.events).toEqual([{ ref: expect.any(String), role: "guest", name: "studio night", opensAt: expect.any(Number), closesAt: expect.any(Number) }]);
  });

  it("an outside L0 host never gets a funnel", async () => {
    const dev = await h.person(DEV, "Dev");
    const e = await h.event({ kind: "outside", level: 0, hostPersonId: dev });
    await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { closed: true }, ADMIN);
    h.clock!.now += 25 * HOUR;
    const view = (await h.post("/host/events", { pass: (await hostPass(DEV)).body.pass })).body;
    expect(view.events[0].funnel).toBeUndefined();
    expect(view.events[0].status).toBe("closed");
  });

  it("the funnel publishes once, a day after close, in bands; later games never change it", async () => {
    const dev = await h.person(DEV, "Dev");
    const e = await h.event({ kind: "outside", level: 1, hostPersonId: dev, handleExchange: false });
    const games: string[] = [];
    for (let i = 0; i < 6; i++) games.push((await h.pair(e.code, `@a${i}:multiversegames.ai`, `@b${i}:multiversegames.ai`)).gameId);
    for (const g of games.slice(0, 4)) await h.repo.stranger.markRunFinished(g, h.now());
    await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { closed: true }, ADMIN);
    // A fresh pass each time: the clock jumps past a pass's lifetime.
    const view = async () => (await h.post("/host/events", { pass: (await hostPass(DEV)).body.pass })).body.events[0];
    h.clock!.now += 23 * HOUR;
    expect((await view()).funnel).toBeNull();
    expect((await h.post(`/admin/host-tools/events/${e.id}/publish`, {}, ADMIN)).status).toBe(409);
    h.clock!.now += 2 * HOUR;
    const funnel = (await view()).funnel;
    expect(funnel).toEqual({ tooSmall: false, joined: "10–19", started: "5–9", finished: "not shown at this size", swapped: null });
    // Never recomputed.
    for (const g of games) await h.repo.stranger.markRunFinished(g, h.now());
    expect((await view()).funnel).toEqual(funnel);
    expect((await h.post(`/admin/host-tools/events/${e.id}/publish`, {}, ADMIN)).status).toBe(409);
  });

  it("under 5 games started: 'too small', and nothing else", async () => {
    const dev = await h.person(DEV, "Dev");
    const e = await h.event({ kind: "outside", level: 1, hostPersonId: dev, handleExchange: false });
    await h.pair(e.code);
    await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { closed: true }, ADMIN);
    h.clock!.now += 25 * HOUR;
    const r = await h.post(`/admin/host-tools/events/${e.id}/publish`, {}, ADMIN);
    expect(r.body.funnel).toEqual({ tooSmall: true });
  });

  it("a host can pause, close and lower their own event; a guest reader and other hosts can't", async () => {
    const dev = await h.person(DEV, "Dev");
    const other = await h.person("@other:multiversegames.ai", "Other");
    void other;
    const e = await h.event({ kind: "outside", level: 3, hostPersonId: dev, handleExchange: false });
    const devPass = (await hostPass(DEV)).body.pass;
    const otherPass = (await hostPass("@other:multiversegames.ai")).body.pass;
    const ref = (await h.post("/host/events", { pass: devPass })).body.events[0].ref as string;
    expect((await h.post(`/host/events/${ref}/pause`, { pass: otherPass })).status).toBe(404);
    expect((await h.post(`/host/events/${e.id}/pause`, { pass: devPass })).status).toBe(404); // raw ids mean nothing here
    expect((await h.post(`/host/events/${ref}/pause`, { pass: devPass })).body.status).toBe("paused");
    expect((await h.post(`/host/events/${ref}/resume`, { pass: devPass })).body.status).toBe("open");
    await h.arrive("@alice:multiversegames.ai", e.code); // terms frozen
    const lowered = await h.post(`/host/events/${ref}/lower`, { pass: devPass });
    expect(lowered.body.level).toBe(1);
    expect((await h.card(e.code)).body.card.version).toBe(2);
    expect((await h.post(`/host/events/${ref}/close`, { pass: devPass })).body.status).toBe("closed");
  });

  it("the deck is static, and hidden like everything else when host tools are off", async () => {
    const r = await h.get("/events/deck");
    expect(r.body.deck).toEqual(JSON.parse(JSON.stringify(DECK)));
    expect(r.body.deck.questions).toHaveLength(10);
    h.hostCfg = { ...h.hostCfg, enabled: false };
    expect((await h.get("/events/deck")).text).toBe((await h.get("/never-built-path")).text);
    expect((await h.post("/host/pass", { openIdToken: `tok:${DEV}` })).text).toBe((await h.post("/never-built-path", {})).text);
  });

  it("H11/H5/H23: no host response carries a raw id, a subject, a Matrix id, a player name or a way to reach a player", async () => {
    const dev = await h.person(DEV, "Dev");
    const jensen = await h.person(JENSEN, "Sister Jensen");
    const e = await h.event({ kind: "outside", level: 1, hostPersonId: dev, handleExchange: false });
    await h.event({ kind: "studio", level: 3, guestReaderId: jensen });
    const games: string[] = [];
    for (let i = 0; i < 5; i++) games.push((await h.pair(e.code, `@p${i}:multiversegames.ai`, `@q${i}:multiversegames.ai`)).gameId);
    await h.req("PATCH", `/admin/host-tools/events/${e.id}`, { closed: true }, ADMIN);
    h.clock!.now += 25 * HOUR;
    const bodies: string[] = [];
    for (const who of [DEV, JENSEN]) {
      const pass = (await hostPass(who)).body.pass;
      bodies.push((await h.post("/host/events", { pass })).text);
    }
    const all = bodies.join("\n");
    expect(all).toContain("5–9");
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(all).not.toMatch(/[0-9a-f]{64}/);
    expect(all).not.toMatch(/@[a-z0-9._=-]+:/i);
    for (const g of games) expect(all).not.toContain(g);
    for (const name of ["Ash", "Bea", "Wren", "Juniper"]) expect(all).not.toContain(name);
    expect(all).not.toMatch(/report|suspend|block|message|send|contact/i);
  });
});
