import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";

/**
 * A queued entry is matched only while its event is open on the card its
 * player accepted: a close ends it (neutrally), a pause holds it, a new card
 * or a new period sends its player back to the card, and a change that lands
 * while a match is being made throws that game away.
 */

const A = "@alice:multiversegames.ai";
const B = "@bob:multiversegames.ai";
const DAY = 24 * 3600 * 1000;

describe("queued entries follow their event", () => {
  let h: HostHarness;
  beforeEach(async () => { h = await new HostHarness({ clock: Date.now() }).boot(); });
  afterEach(async () => { await h.close(); });

  const poll = async (pass: string) => (await h.post("/stranger/queue/poll", { pass }, h.ipFor(pass))).body;
  const patch = (id: string, body: unknown) => h.req("PATCH", `/admin/host-tools/events/${id}`, body, ADMIN);

  it("closed mid-queue: the waiting player gets the neutral ending, and no game is made", async () => {
    const e = await h.event({});
    const a = await h.arrive(A, e.code);
    expect((await h.queue(a)).body.status).toBe("waiting");
    await patch(e.id, { closed: true });
    expect(await poll(a)).toEqual({ status: "ended" });
    // Told once; after that the closed meetup answers like any path that was never built.
    expect((await h.post("/stranger/queue/poll", { pass: a }, h.ipFor(a))).text).toBe((await h.post("/never-built-path", {})).text);
    expect(await h.repo.stranger.runsForEvent(e.id)).toEqual([]);
  });

  it("paused: entries are held unmatched; resumed: they pair", async () => {
    const e = await h.event({});
    const a = await h.arrive(A, e.code);
    const b = await h.arrive(B, e.code);
    await h.queue(a);
    await patch(e.id, { paused: true });
    expect((await h.queue(b)).status).toBe(409);
    expect((await poll(a)).status).toBe("waiting");
    await patch(e.id, { paused: false });
    expect((await h.queue(b)).status).toBe(200);
    expect((await poll(a)).status).toBe("matched");
  });

  it("a lowered level mid-queue sends the waiting player back to the new card", async () => {
    const dev = await h.person("@dev:multiversegames.ai", "Dev");
    const e = await h.event({ kind: "outside", level: 3, hostPersonId: dev, handleExchange: false });
    const a = await h.arrive(A, e.code);
    await h.queue(a);
    await patch(e.id, { level: 1 });
    expect(await poll(a)).toEqual({ status: "card_changed" });
    expect((await h.post("/events/ack", { meetup: e.code, cardVersion: 2, pass: a })).status).toBe(200);
    expect((await h.queue(a)).body.status).toBe("waiting");
    const b = await h.arrive(B, e.code);
    expect((await h.queue(b)).body.status).toBe("matched");
    const [run] = await h.repo.stranger.runsForEvent(e.id);
    expect(run).toBeTruthy();
  });

  it("a meetup code's new period: the waiting player re-accepts the new card before they can be paired", async () => {
    await h.close();
    h = await new HostHarness({ clock: Date.now(), stranger: { meetupCodes: new Set(["tea-party"]) } }).boot();
    const a = await h.arrive(A, "tea-party");
    await h.queue(a);
    h.clock!.now += 15 * DAY;
    expect(await poll(a)).toEqual({ status: "card_changed" });
    const card = (await h.card("tea-party")).body.card; // the roll
    expect((await h.queue(a)).status).toBe(409); // the old acknowledgement doesn't count
    expect((await h.post("/events/ack", { meetup: "tea-party", cardVersion: card.version, pass: a })).status).toBe(200);
    expect((await h.queue(a)).body.status).toBe("waiting");
    const b = await h.arrive(B, "tea-party");
    expect((await h.queue(b)).body.status).toBe("matched");
    const runs = [...(h.repo.stranger as any).runs.values()];
    const live = [...(h.repo.hosts as any).events.values()].find((x: any) => x.closedAt === null);
    expect(runs.map((r: any) => r.eventId)).toEqual([live.id]);
  });

  for (const change of ["closed", "paused"] as const) {
    it(`a ${change === "closed" ? "close" : "pause"} that lands while a match is being made throws that game away`, async () => {
      const e = await h.event({});
      const a = await h.arrive(A, e.code);
      const b = await h.arrive(B, e.code);
      const matching = h.stranger.matching as any;
      const real = matching.deps.hooks.createGame;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let started!: () => void;
      const inFlight = new Promise<void>((r) => { started = r; });
      matching.deps.hooks.createGame = async (...args: unknown[]) => {
        started();
        await gate;
        return real(...args);
      };
      await h.queue(a);
      const joining = h.queue(b);
      await inFlight;
      await patch(e.id, change === "closed" ? { closed: true } : { paused: true });
      release();
      const joinResult = await joining;
      matching.deps.hooks.createGame = real;
      const runs = await h.repo.stranger.runsForEvent(e.id);
      expect(runs.every((r) => r.discarded)).toBe(true);
      if (change === "closed") {
        expect(await poll(a)).toEqual({ status: "ended" });
        expect(joinResult.body).toEqual({ status: "ended" }); // B is told in its own join's answer
      } else {
        expect((await poll(a)).status).toBe("waiting");
        expect((await poll(b)).status).toBe("waiting");
        await patch(e.id, { paused: false });
        await poll(a); // kicks a matching pass
        await new Promise((r) => setTimeout(r, 50));
        expect((await poll(a)).status).toBe("matched");
        expect((await poll(b)).status).toBe("matched");
      }
    });
  }
});
