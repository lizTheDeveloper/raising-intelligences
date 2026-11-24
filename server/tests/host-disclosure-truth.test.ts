import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { CODE_ACCESS_MS, CODE_REDEEM_MS, SHARE_WINDOW_MS } from "../src/hosts/config.js";
import type { TestClient } from "./helpers/socket-client.js";

/**
 * Every sentence a player reads about their data must be literally true
 * (persona tests "studio-jensen" and "dating-class-therapy", RI 2.12.0).
 * Where the code and the copy disagreed, the code now keeps the promise.
 */

const READER = "@reader:multiversegames.ai";
const HOST = "@host:multiversegames.ai";
const MIN = 60_000;
const DAY = 24 * 3600_000;

describe("host tools: the account page and unlink keep their promises", () => {
  let h: HostHarness;
  let readerId: string;
  let hostId: string;
  let n = 0;

  beforeEach(async () => {
    h = await new HostHarness({ clock: Date.now() }).boot();
    readerId = await h.person(READER, "Sister Jensen");
    hostId = await h.person(HOST, "Kit");
  });
  afterEach(async () => { await h.close(); });

  async function finished(code: string) {
    n++;
    const a = `@a${n}:multiversegames.ai`;
    const b = `@b${n}:multiversegames.ai`;
    const p = await h.pair(code, a, b);
    const state = h.built.games.get(p.gameId)!;
    state.phase = "report_card";
    await h.repo.saveEndgame(p.gameId, "At twenty-five they keep a small garden.", "# Report card\n## Personality\nCareful. Funny.\n## Strengths\nPatient with plants.\n## Struggles\nSaying no.");
    await h.repo.stranger.markRunFinished(p.gameId, h.now());
    return { ...p, a, b };
  }
  const decide = async (c: TestClient, answer: string) => {
    const got = c.waitFor<any>(E.SHARE_STATE);
    c.emit(E.SHARE_DECISION, { answer });
    return got;
  };
  const learn = async (c: TestClient, answer: unknown) => {
    const got = c.waitFor<any>(E.STUDIO_LEARNING_STATE);
    c.emit(E.STUDIO_LEARNING, { answer });
    return got;
  };
  const accountPass = async (mxid: string) => (await h.post("/stranger/account/pass", { openIdToken: `tok:${mxid}` })).body.pass as string;
  const account = async (mxid: string) => (await h.post("/stranger/account", { pass: await accountPass(mxid) })).body;
  const close = async (id: string) => h.req("PATCH", `/admin/host-tools/events/${id}`, { closed: true }, ADMIN);

  describe("1. what your host saw", () => {
    it("a studio event with a guest reader: nothing, even a day after close, and no funnel is ever published", async () => {
      const ev = await h.event({ kind: "studio", level: 3, guestReaderId: readerId, handleExchange: false, name: "LDS singles game night" });
      const g = await finished(ev.code);
      expect((await account(g.a)).hostSaw).toEqual([{ name: "LDS singles game night", panel: { kind: "nothing", who: "guest", reader: "Sister Jensen" } }]);
      await close(ev.id);
      h.clock!.now += 26 * 3600_000;
      expect((await account(g.a)).hostSaw).toEqual([{ name: "LDS singles game night", panel: { kind: "nothing", who: "guest", reader: "Sister Jensen" } }]);
      // Loading the page computed nothing and published nothing.
      expect((await h.repo.hosts.getEvent(ev.id))!.publishedFunnel).toBeNull();
      // The admin can't publish one for a studio event either.
      expect((await h.post(`/admin/host-tools/events/${ev.id}/publish`, {}, ADMIN)).status).toBe(409);
      expect((await h.repo.hosts.getEvent(ev.id))!.publishedFunnel).toBeNull();
    });

    it("a studio event without a guest: nobody outside the studio", async () => {
      const ev = await h.event({ kind: "studio", level: 0, studioLearning: true, handleExchange: false, name: "seed library" });
      const g = await finished(ev.code);
      await close(ev.id);
      h.clock!.now += 26 * 3600_000;
      expect((await account(g.a)).hostSaw).toEqual([{ name: "seed library", panel: { kind: "nothing", who: "nobody" } }]);
      expect((await h.repo.hosts.getEvent(ev.id))!.publishedFunnel).toBeNull();
    });

    it("an outside level-0 host: only whether the meetup was open", async () => {
      const ev = await h.event({ kind: "outside", level: 0, hostPersonId: hostId, handleExchange: false, name: "board games" });
      const g = await finished(ev.code);
      expect((await account(g.a)).hostSaw).toEqual([{ name: "board games", panel: { kind: "status", host: "Kit" } }]);
    });

    it("an outside level-1 host: pending, then the published funnel the host sees", async () => {
      const ev = await h.event({ kind: "outside", level: 1, hostPersonId: hostId, handleExchange: false, name: "board games" });
      const g = await finished(ev.code);
      expect((await account(g.a)).hostSaw).toEqual([{ name: "board games", panel: { kind: "pending", host: "Kit" } }]);
      await close(ev.id);
      h.clock!.now += 26 * 3600_000;
      const panel = (await account(g.a)).hostSaw[0].panel;
      expect(panel.kind).toBe("funnel");
      expect(panel.host).toBe("Kit");
      expect(panel.funnel).toEqual((await h.repo.hosts.getEvent(ev.id))!.publishedFunnel);
    });
  });

  describe("4. unlink takes the name, the credential and the listing", () => {
    async function unlinked() {
      const ev = await h.event({ kind: "studio", level: 3, guestReaderId: readerId, handleExchange: false, name: "garden club" });
      const g = await finished(ev.code);
      // A's browser synced the kid to the account, with its seat token as proof.
      const syncA = () => h.post(`/user/${encodeURIComponent(g.a)}/kids`, [{ gameId: g.gameId, childName: "Wren", playerToken: g.ma.playerToken }], { "x-matrix-openid": `tok:${g.a}` });
      expect((await syncA()).status).toBe(200);
      const kidsA = async () => (await h.get(`/user/${encodeURIComponent(g.a)}/kids`, { "x-matrix-openid": `tok:${g.a}` })).body as unknown as Array<{ gameId: string }>;
      expect((await kidsA()).map((k) => k.gameId)).toContain(g.gameId);
      const pass = await accountPass(g.a);
      const ref = (await h.post("/stranger/account", { pass })).body.games[0].ref;
      await h.post("/stranger/account/unlink", { pass, gameRef: ref });
      const id = (await h.get("/admin/host-tools/unlink-requests", ADMIN)).body.requests[0].id;
      expect((await h.post(`/admin/host-tools/unlink-requests/${id}/done`, {}, ADMIN)).status).toBe(200);
      return { g, syncA, kidsA };
    }

    it("the co-parent sees 'Parent 1', not the name, in the saved seat and the live lobby", async () => {
      const { g } = await unlinked();
      const saved = await h.repo.loadPlayers(g.gameId);
      expect(saved.find((p) => p.slot === "parent1")!.displayName).toBe("Parent 1");
      expect(saved.find((p) => p.slot === "parent2")!.displayName).toBe("Bea");
      // B reconnects: the lobby names the unlinked seat only by its placeholder.
      const c = await h.client();
      const lobby = c.waitFor<any>(E.LOBBY);
      c.emit(E.JOIN_GAME, { gameId: g.gameId, playerToken: g.mb.playerToken, strangerPass: g.pb });
      const l = await lobby;
      expect(l.players.find((p: any) => p.slot === "parent1").displayName).toBe("Parent 1");
      expect(JSON.stringify(l)).not.toContain("Ash");
    });

    it("the old seat token no longer reads the game; the co-parent's still does", async () => {
      const { g } = await unlinked();
      const read = (token: string) => h.get(`/game/${g.gameId}/state`, { "x-player-token": token });
      expect((await read(g.ma.playerToken)).status).toBe(403);
      expect((await read(g.mb.playerToken)).status).toBe(200);
    });

    it("the game leaves the player's kid list, and a later sync can't put it back", async () => {
      const { g, syncA, kidsA } = await unlinked();
      expect((await kidsA()).map((k) => k.gameId)).not.toContain(g.gameId);
      await syncA();
      expect((await kidsA()).map((k) => k.gameId)).not.toContain(g.gameId);
    });

    it("the co-parent's game keeps working: B rejoins and plays on", async () => {
      const { g } = await unlinked();
      const c = await h.client();
      const joined = c.waitFor<any>(E.JOINED);
      c.emit(E.JOIN_GAME, { gameId: g.gameId, playerToken: g.mb.playerToken, strangerPass: g.pb });
      expect((await joined).slot).toBe("parent2");
      expect((await account(g.b)).games).toHaveLength(1);
    });
  });

  describe("6. a code's date is the latest date anyone can read it", () => {
    it("before it's opened: open-by, and the read-until that follows; after: the real read-until", async () => {
      const ev = await h.event({ kind: "studio", level: 3, guestReaderId: readerId, handleExchange: false, name: "garden club" });
      const g = await finished(ev.code);
      await decide(g.A, "yes"); await decide(g.B, "yes");
      h.clock!.now += 11 * MIN;
      const code = (await h.repo.hosts.codeByGame(g.gameId))!;
      const row = (await account(g.a)).games[0].share;
      expect(row.state).toBe("code");
      expect(row.openBy).toBe(code.expiresAt);
      expect(row.until).toBe(code.expiresAt + CODE_ACCESS_MS);
      expect(code.expiresAt).toBe(code.visibleAt + CODE_REDEEM_MS);
      h.clock!.now += 3 * DAY;
      const hostPass = (await h.post("/host/pass", { openIdToken: `tok:${READER}` })).body.pass;
      expect((await h.post("/host/codes/redeem", { pass: hostPass, words: row.words })).status).toBe(200);
      const after = (await account(g.a)).games[0].share;
      expect(after.openBy).toBeUndefined();
      expect(after.until).toBe(h.now() + CODE_ACCESS_MS);
      expect(after.until).toBeLessThanOrEqual(row.until);
    });
  });

  describe("10. no can become yes while the window is open, and the co-parent can't tell", () => {
    it("no, then yes: a code is made as for any second yes; nothing reaches the other seat", async () => {
      const ev = await h.event({ kind: "studio", level: 3, guestReaderId: readerId, handleExchange: false, name: "garden club" });
      const g = await finished(ev.code);
      const bHeard: unknown[] = [];
      expect(await decide(g.B, "yes")).toEqual({ view: { state: "waiting" } });
      g.B.socket.on(E.SHARE_STATE, (p: unknown) => bHeard.push(p));
      const no = await decide(g.A, "no");
      expect(no).toEqual({ view: { state: "no", until: expect.any(Number) } });
      expect((await account(g.a)).games[0].share).toEqual({ state: "no", until: no.view.until });
      // B's row is the same as for any partner who hasn't said yes.
      expect((await account(g.b)).games[0].share).toEqual({ state: "waiting" });
      expect(await decide(g.A, "yes")).toEqual({ view: { state: "waiting" } });
      await new Promise((r) => setTimeout(r, 50));
      expect(bHeard).toEqual([]);
      expect(h.built.share!.drawn.some((d) => d.gameId === g.gameId)).toBe(true);
      h.clock!.now += 11 * MIN;
      expect((await account(g.b)).games[0].share.state).toBe("code");
    });

    it("from the account page too; and not after the window closes", async () => {
      const ev = await h.event({ kind: "studio", level: 3, guestReaderId: readerId, handleExchange: false, name: "garden club" });
      const g = await finished(ev.code);
      await decide(g.A, "no");
      const pass = await accountPass(g.a);
      const ref = (await h.post("/stranger/account", { pass })).body.games[0].ref;
      expect((await h.post("/stranger/account/decide", { pass, gameRef: ref, answer: "yes" })).body.share).toEqual({ state: "waiting" });
      const g2 = await finished(ev.code);
      await decide(g2.A, "no");
      h.clock!.now += SHARE_WINDOW_MS + MIN;
      const pass2 = await accountPass(g2.a);
      const ref2 = (await h.post("/stranger/account", { pass: pass2 })).body.games[0].ref;
      expect((await h.post("/stranger/account", { pass: pass2 })).body.games[0].share).toEqual({ state: "none" });
      expect((await h.post("/stranger/account/decide", { pass: pass2, gameRef: ref2, answer: "yes" })).status).toBe(409);
    });
  });

  describe("11. studio learning: a yes can be withdrawn from the account page", () => {
    it("withdrawing takes the game off the analysis allow-list; the co-parent's answer is untouched", async () => {
      const ev = await h.event({ kind: "studio", level: 0, studioLearning: true, handleExchange: false, name: "seed library" });
      const g = await finished(ev.code);
      await learn(g.A, "yes"); await learn(g.B, "yes");
      const allow = async () => (await h.get("/admin/host-tools/analysis-allowlist", ADMIN)).body.games as string[];
      expect(await allow()).toContain(g.gameId);
      const pass = await accountPass(g.a);
      const ref = (await h.post("/stranger/account", { pass })).body.games[0].ref;
      const r = await h.post("/stranger/account/learning", { pass, gameRef: ref, answer: "no" });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ learning: "no" });
      expect(await allow()).not.toContain(g.gameId);
      expect((await account(g.a)).games[0].learning).toBe("no");
      expect((await account(g.b)).games[0].learning).toBe("yes");
    });

    it("only 'no' is accepted there, and only where learning was offered", async () => {
      const ev = await h.event({ kind: "studio", level: 0, studioLearning: true, handleExchange: false, name: "seed library" });
      const g = await finished(ev.code);
      const pass = await accountPass(g.a);
      const ref = (await h.post("/stranger/account", { pass })).body.games[0].ref;
      expect((await h.post("/stranger/account/learning", { pass, gameRef: ref, answer: "yes" })).status).toBe(400);
      const out = await h.event({ kind: "outside", level: 0, hostPersonId: hostId, handleExchange: false, name: "board games" });
      const g2 = await finished(out.code);
      const pass2 = await accountPass(g2.a);
      const ref2 = (await h.post("/stranger/account", { pass: pass2 })).body.games[0].ref;
      expect((await h.post("/stranger/account/learning", { pass: pass2, gameRef: ref2, answer: "no" })).status).toBe(404);
    });
  });

  describe("12. a stopped code says so on both rows", () => {
    async function withCode() {
      const ev = await h.event({ kind: "studio", level: 3, guestReaderId: readerId, handleExchange: false, name: "garden club" });
      const g = await finished(ev.code);
      await decide(g.A, "yes"); await decide(g.B, "yes");
      h.clock!.now += 11 * MIN;
      return g;
    }

    it("A stops it: A reads 'you stopped it', B reads that it no longer opens", async () => {
      const g = await withCode();
      const pass = await accountPass(g.a);
      const ref = (await h.post("/stranger/account", { pass })).body.games[0].ref;
      await h.post("/stranger/account/stop", { pass, gameRef: ref });
      expect((await account(g.a)).games[0].share).toEqual({ state: "stopped", at: h.now() });
      expect((await account(g.b)).games[0].share).toEqual({ state: "ended" });
    });

    it("a code that can't open any more (excluded later, or never opened in time) reads as ended on both rows", async () => {
      const g = await withCode();
      (h.repo.childSafety as any).cases.set("late", { gameRef: g.gameId });
      expect((await account(g.a)).games[0].share).toEqual({ state: "ended" });
      expect((await account(g.b)).games[0].share).toEqual({ state: "ended" });
      const g2 = await withCode();
      h.clock!.now += CODE_REDEEM_MS + MIN;
      expect((await account(g2.a)).games[0].share).toEqual({ state: "ended" });
    });
  });

  describe("8. 'remove from my list' deletes the attendance record", () => {
    it("the acknowledgement rows for that meetup are gone, not hidden", async () => {
      const ev = await h.event({ kind: "studio", level: 0, handleExchange: false, name: "LDS singles game night" });
      const g = await finished(ev.code);
      const subject = await h.stranger.age.subjectHash(g.a);
      expect((await h.repo.hosts.acksForSubject(subject)).filter((a) => a.eventId === ev.id).length).toBeGreaterThan(0);
      const pass = await accountPass(g.a);
      const page = (await h.post("/stranger/account", { pass })).body;
      expect((await h.post("/stranger/account/forget-meetup", { pass, eventRef: page.meetups[0].ref })).status).toBe(200);
      expect((await h.repo.hosts.acksForSubject(subject)).filter((a) => a.eventId === ev.id)).toEqual([]);
      expect((await account(g.a)).meetups).toEqual([]);
      // The game itself is a separate record and stays on the account until it's taken off.
      expect((await account(g.a)).games).toHaveLength(1);
    });
  });
});
