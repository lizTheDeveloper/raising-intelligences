import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { isGameHosted, __resetHostedGamesForTests, filterHostedObservations, hostedTraceIdsToDrop, HOSTED_NO_ANALYSIS_TAG } from "../src/observability/hosted-analysis.js";
import type { TestClient } from "./helpers/socket-client.js";

/**
 * Host tools PR 4 (spec §5.4, §6, §10, B.2 learning.ts, B.3, H15, H18, H20):
 * the studio-learning step, trace tagging and the analysis allow-list,
 * "take this game off my account", and the retention purge.
 */

const READER = "@reader:multiversegames.ai";
const HOST = "@host:multiversegames.ai";
const MIN = 60_000;
const DAY = 24 * 3600_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("host tools: studio learning, unlink, purge", () => {
  let h: HostHarness;
  let readerId: string;
  let hostId: string;
  let studio: { id: string; code: string };
  let outside: { id: string; code: string };
  let n = 0;

  beforeEach(async () => {
    __resetHostedGamesForTests();
    h = await new HostHarness({ clock: Date.now() }).boot();
    readerId = await h.person(READER, "Robin");
    hostId = await h.person(HOST, "Kit");
    studio = await h.event({ kind: "studio", level: 3, guestReaderId: readerId, studioLearning: true, handleExchange: false, name: "garden club" });
    outside = await h.event({ kind: "outside", level: 3, hostPersonId: hostId, handleExchange: false, name: "board games" });
  });
  afterEach(async () => { await h.close(); });

  async function finished(code = studio.code) {
    n++;
    const a = `@a${n}:multiversegames.ai`;
    const b = `@b${n}:multiversegames.ai`;
    const p = await h.pair(code, a, b);
    const state = h.built.games.get(p.gameId)!;
    state.phase = "report_card";
    await h.repo.saveEndgame(p.gameId, "At twenty-five they keep a small garden.", "# Report card\n## How They Grew\nThey grew.\n## What Comes Next\nSundays.");
    await h.repo.stranger.markRunFinished(p.gameId, h.now());
    return { ...p, a, b };
  }

  const learn = async (c: TestClient, answer: unknown) => {
    const got = c.waitFor<any>(E.STUDIO_LEARNING_STATE);
    c.emit(E.STUDIO_LEARNING, { answer });
    return got;
  };
  const decide = async (c: TestClient, answer: string) => {
    const got = c.waitFor<any>(E.SHARE_STATE);
    c.emit(E.SHARE_DECISION, { answer });
    return got;
  };
  const accountPass = async (mxid: string) => (await h.post("/stranger/account/pass", { openIdToken: `tok:${mxid}` })).body.pass as string;
  const account = async (mxid: string) => (await h.post("/stranger/account", { pass: await accountPass(mxid) })).body;
  const allowlist = async () => (await h.get("/admin/host-tools/analysis-allowlist", ADMIN)).body.games as string[];

  describe("studio learning (H18, H20)", () => {
    it("is offered after the report card at a studio event that has it, and nowhere else", async () => {
      expect(h.hosts.endScreens(studio.id)?.learning).toBe(true);
      expect(h.hosts.endScreens(outside.id)?.learning).toBe(false);
      const plain = await h.event({ kind: "studio", level: 0, studioLearning: false, name: "no learning" });
      expect(h.hosts.endScreens(plain.id)?.learning).toBe(false);
    });

    it("the reply is the same whatever the answer, and nothing reaches the co-parent", async () => {
      const g = await finished();
      let leaked = 0;
      g.B.socket.on(E.STUDIO_LEARNING_STATE, () => { leaked++; });
      expect(await learn(g.A, "status")).toEqual({ view: { answered: false } });
      const yes = await learn(g.A, "yes");
      const g2 = await finished();
      const no = await learn(g2.A, "no");
      expect(yes).toEqual(no);
      expect(yes).toEqual({ view: { answered: true } });
      await new Promise((r) => setTimeout(r, 50));
      expect(leaked).toBe(0);
      // The first answer stands.
      await learn(g.A, "no");
      expect(await h.repo.hosts.getLearning(g.gameId)).toEqual([{ slot: "parent1", answer: "yes" }]);
    });

    it("is refused before the report card, at outside events, and for anything but yes or no", async () => {
      const early = await finished();
      h.built.games.get(early.gameId)!.phase = "playing" as any;
      expect((await learn(early.A, "yes")).error).toBeTruthy();
      const out = await finished(outside.code);
      expect((await learn(out.A, "yes")).error).toBeTruthy();
      const g = await finished();
      expect((await learn(g.A, "maybe")).error).toBeTruthy();
      expect(await h.repo.hosts.getLearning(out.gameId)).toEqual([]);
      expect(await h.repo.hosts.getLearning(g.gameId)).toEqual([]);
    });

    it("analysis is allowed only for a studio-event game with two yeses that isn't excluded (H15)", async () => {
      const both = await finished();
      await learn(both.A, "yes"); await learn(both.B, "yes");
      const oneNo = await finished();
      await learn(oneNo.A, "yes"); await learn(oneNo.B, "no");
      const oneOnly = await finished();
      await learn(oneOnly.A, "yes");
      const rung = await finished();
      await learn(rung.A, "yes"); await learn(rung.B, "yes");
      h.built.games.get(rung.gameId)!.highestRungFired = 1;
      expect(await allowlist()).toEqual([both.gameId]);
      expect((await h.get("/admin/host-tools/analysis-allowlist")).status).toBe(401);
    });

    it("the account page shows a player their own answer, never the co-parent's", async () => {
      const g = await finished();
      await learn(g.A, "no");
      expect((await account(g.a)).games[0].learning).toBe("no");
      expect((await account(g.b)).games[0].learning).toBe("unanswered");
      const out = await finished(outside.code);
      expect((await account(out.a)).games[0].learning).toBeNull();
    });
  });

  describe("trace tagging (H18)", () => {
    it("a game matched at an event is tagged hosted_no_analysis from the start; an event-less game is not", async () => {
      const g = await finished();
      expect(isGameHosted(g.gameId)).toBe(true);
      expect(isGameHosted("some-other-game")).toBe(false);
    });

    it("after a restart, every game at an event is tagged again before play resumes", async () => {
      const g = await finished();
      __resetHostedGamesForTests();
      expect(isGameHosted(g.gameId)).toBe(false);
      await h.hosts.markHostedGames();
      expect(isGameHosted(g.gameId)).toBe(true);
    });

    it("readers drop hosted traces unless the game is on the allow-list", () => {
      const traces = [
        { id: "t1", tags: [HOSTED_NO_ANALYSIS_TAG, "game_id:g-hosted"] },
        { id: "t2", tags: [HOSTED_NO_ANALYSIS_TAG, "game_id:g-allowed"] },
        { id: "t3", tags: ["game_id:g-plain"] },
      ];
      const drop = hostedTraceIdsToDrop(traces, new Set(["g-allowed"]));
      expect([...drop]).toEqual(["t1"]);
      const obs = [{ traceId: "t1" }, { traceId: "t2" }, { traceId: "t3" }, { traceId: null }];
      expect(filterHostedObservations(obs, drop)).toEqual([{ traceId: "t2" }, { traceId: "t3" }, { traceId: null }]);
    });
  });

  describe("take this game off my account (§6)", () => {
    async function withCode() {
      const g = await finished();
      await decide(g.A, "yes"); await decide(g.B, "yes");
      await learn(g.A, "yes"); await learn(g.B, "yes");
      h.clock!.now += 11 * MIN;
      return g;
    }
    const unlink = async (mxid: string, gameRef?: string) => {
      const pass = await accountPass(mxid);
      const ref = gameRef ?? (await h.post("/stranger/account", { pass })).body.games[0].ref;
      return h.post("/stranger/account/unlink", { pass, gameRef: ref });
    };

    it("a request voids the code at once, silently: the co-parent's row doesn't change", async () => {
      const g = await withCode();
      const before = (await account(g.b)).games[0];
      expect(before.share.state).toBe("code");
      const hostPass = (await h.post("/host/pass", { openIdToken: `tok:${READER}` })).body.pass;
      const r = await unlink(g.a);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect((await account(g.a)).games[0].unlink).toBe("requested");
      expect((await account(g.b)).games[0]).toEqual(before);
      const redeem = await h.post("/host/codes/redeem", { pass: hostPass, words: before.share.words });
      expect(redeem.status).toBe(404);
      // A second request is the same request.
      await unlink(g.a);
      expect((await h.get("/admin/host-tools/unlink-requests", ADMIN)).body.requests).toHaveLength(1);
    });

    it("a ref that isn't the caller's seat is refused like any unknown ref", async () => {
      const g = await withCode();
      const other = await finished();
      const theirRef = (await account(other.a)).games[0].ref;
      expect((await unlink(g.a, theirRef)).status).toBe(404);
      expect((await unlink(g.a, "nope")).status).toBe(404);
      expect((await h.post("/stranger/account/unlink", { pass: "bad", gameRef: "x" })).status).toBe(401);
    });

    it("the admin queue shows no subject or Matrix id; done unlinks the seat everywhere (H11)", async () => {
      // No code yet: both decisions are still stored.
      const g = await finished();
      await decide(g.A, "yes"); await decide(g.B, "later");
      await learn(g.A, "yes"); await learn(g.B, "yes");
      expect((await h.repo.hosts.getDecisions(g.gameId)).map((d) => d.slot).sort()).toEqual(["parent1", "parent2"]);
      await unlink(g.a);
      const q = await h.get("/admin/host-tools/unlink-requests", ADMIN);
      expect(q.status).toBe(200);
      const subjectA = await h.stranger.age.subjectHash(g.a);
      expect(q.text).not.toContain(subjectA);
      expect(q.text).not.toContain(g.a);
      const id = q.body.requests[0].id;
      expect((await h.post(`/admin/host-tools/unlink-requests/${id}/done`, {}, ADMIN)).status).toBe(200);
      // Off the account page: no game, no meetup.
      const page = await account(g.a);
      expect(page.games).toEqual([]);
      expect(page.meetups).toEqual([]);
      // Their decisions and learning choice are gone; the co-parent's stay.
      expect((await h.repo.hosts.getDecisions(g.gameId)).map((d) => d.slot)).toEqual(["parent2"]);
      expect(await h.repo.hosts.getLearning(g.gameId)).toEqual([{ slot: "parent2", answer: "yes" }]);
      // The run no longer names them.
      const run = await h.repo.stranger.getRun(g.gameId);
      expect(run!.parent1).not.toBe(subjectA);
      expect(run!.parent2).toBe(await h.stranger.age.subjectHash(g.b));
      // The co-parent keeps the game, and its row is unchanged.
      expect((await account(g.b)).games).toHaveLength(1);
      expect(h.built.games.get(g.gameId)).toBeTruthy();
      // Not on the allow-list any more.
      expect(await allowlist()).not.toContain(g.gameId);
      // Done twice: no such open request.
      expect((await h.post(`/admin/host-tools/unlink-requests/${id}/done`, {}, ADMIN)).status).toBe(404);
    });

    it("the unlinked seat can't come back to the game", async () => {
      const g = await withCode();
      await unlink(g.a);
      const id = (await h.get("/admin/host-tools/unlink-requests", ADMIN)).body.requests[0].id;
      await h.post(`/admin/host-tools/unlink-requests/${id}/done`, {}, ADMIN);
      const c = await h.client();
      const err = c.waitFor<any>(E.ERROR);
      c.emit(E.JOIN_GAME, { gameId: g.gameId, playerToken: g.ma.playerToken, strangerPass: g.pa });
      expect((await err).error).toBe("This game is private.");
    });

    it("a report the co-parent files after the unlink still reaches the original account", async () => {
      const g = await withCode();
      await unlink(g.a);
      const id = (await h.get("/admin/host-tools/unlink-requests", ADMIN)).body.requests[0].id;
      await h.post(`/admin/host-tools/unlink-requests/${id}/done`, {}, ADMIN);
      const reported = g.B.waitFor(E.STRANGER_REPORTED);
      g.B.emit(E.STRANGER_REPORT, { reason: "said something awful" });
      await reported;
      const subjectA = await h.stranger.age.subjectHash(g.a);
      const reports = await h.repo.stranger.reportsForGame(g.gameId);
      expect(reports).toHaveLength(1);
      expect(reports[0].reported).toBe(subjectA);
      expect(await h.repo.stranger.isSuspended(subjectA)).toBe(true);
    });

    it("the route is hidden when host tools are off", async () => {
      h.hostCfg.enabled = false;
      const r = await h.post("/stranger/account/unlink", { pass: "x", gameRef: "y" });
      const never = await h.post("/never-built-path", { pass: "x" });
      expect(r.status).toBe(never.status);
      expect(r.body).toEqual(never.body);
    });

    it("account responses carry no game id, subject or Matrix id (H11)", async () => {
      const g = await withCode();
      const r = await unlink(g.a);
      const page = await h.post("/stranger/account", { pass: await accountPass(g.a) });
      for (const text of [r.text, page.text]) {
        expect(text).not.toMatch(UUID);
        expect(text).not.toContain(g.a);
        expect(text).not.toContain(await h.stranger.age.subjectHash(g.a));
      }
    });
  });

  describe("purge (§10)", () => {
    it("runs the schedule and returns only counts per table", async () => {
      const g = await finished();
      await decide(g.A, "yes");
      expect((await h.post("/admin/host-tools/purge", {})).status).toBe(401);
      const first = await h.post("/admin/host-tools/purge", {}, ADMIN);
      expect(first.status).toBe(200);
      for (const v of Object.values(first.body.deleted)) expect(typeof v).toBe("number");
      expect(first.body.deleted.host_event_acks).toBe(0);
      // A year and a bit after the event closed, acknowledgements go.
      h.clock!.now += 400 * DAY;
      const later = await h.post("/admin/host-tools/purge", {}, ADMIN);
      expect(later.body.deleted.host_event_acks).toBeGreaterThan(0);
      expect(later.body.deleted.share_decisions).toBeGreaterThan(0);
      expect(later.text).not.toMatch(UUID);
    });
  });
});
