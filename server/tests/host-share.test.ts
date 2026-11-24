import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HostHarness, ADMIN } from "./helpers/host-tools.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { markGameHeld } from "../src/observability/child-safety-exclusion.js";
import { CODE_NOT_AVAILABLE } from "../src/hosts/share.js";
import type { TestClient } from "./helpers/socket-client.js";

/**
 * Share codes (spec §5, B1, B2, B3, H1–H11, H14, H15): every finished game at
 * a share-code event gets the same step; a game that can't make a code is
 * indistinguishable to its players; a code carries only the scrubbed
 * snapshot, opens for its reader only, and every failure looks the same.
 */

const DEV = "@dev:multiversegames.ai";
const OTHER_HOST = "@other:multiversegames.ai";
const MIN = 60_000;
const DAY = 24 * 3600_000;
const SENTINEL = "the blue heron sleeps under the old mill bridge tonight";

const REPORT_CARD = [
  "# Report card",
  "## How They Grew",
  "Wren grew into a careful, funny adult. Ash and Bea argued often but always came back to the table.",
  "They learned that being wrong out loud was survivable. They kept a garden together for years.",
  `Wren once said ${SENTINEL} and nobody understood why.`,
  "## The Voices in Their Head",
  "Wren still hears Ash saying be gentle with yourself.",
  "## Notable Quotes That Stuck",
  "\"you are allowed to take up space in this house\"",
  "## What Comes Next",
  "Wren is going to be fine. Wren is going to call home on Sundays.",
].join("\n");
const EPILOGUE = "At twenty-five, Wren lives near the coast. Wren calls Ash and Bea on Sundays. The garden is still there.";

describe("share codes", () => {
  let h: HostHarness;
  let devId: string;
  let otherId: string;
  let event: { id: string; code: string };

  beforeEach(async () => {
    h = await new HostHarness({ clock: Date.now() }).boot();
    devId = await h.person(DEV, "Robin");
    otherId = await h.person(OTHER_HOST, "Kit");
    event = await h.event({ kind: "outside", level: 3, hostPersonId: devId, handleExchange: false });
    await h.event({ kind: "outside", level: 3, hostPersonId: otherId, handleExchange: false });
  });
  afterEach(async () => { await h.close(); });

  let n = 0;
  /** Two players, matched and seated, through to a finished game at the report card. */
  async function finished(opts: { private?: string; tweak?: (s: any) => void } = {}) {
    n++;
    const p = await h.pair(event.code, `@a${n}:multiversegames.ai`, `@b${n}:multiversegames.ai`);
    const state = h.built.games.get(p.gameId)!;
    state.phase = "report_card";
    state.messages.push(
      { sender: "parent1", content: "we can talk about anything at this table, always", chatType: "shared", visibleTo: ["parent1", "parent2", "kid"], timestamp: 1, eventNumber: 1 },
      { sender: "parent1", content: opts.private ?? "i never told your other parent about the letter", chatType: "private", visibleTo: ["parent1", "kid"], timestamp: 2, eventNumber: 1 },
    );
    opts.tweak?.(state);
    await h.repo.saveEndgame(p.gameId, EPILOGUE, REPORT_CARD);
    await h.repo.stranger.markRunFinished(p.gameId, h.now());
    return p;
  }

  const decide = async (c: TestClient, answer: string) => {
    const got = c.waitFor<any>(E.SHARE_STATE);
    c.emit(E.SHARE_DECISION, { answer });
    return got;
  };
  const accountPass = async (mxid: string) => (await h.post("/stranger/account/pass", { openIdToken: `tok:${mxid}` })).body.pass as string;
  const account = async (mxid: string) => (await h.post("/stranger/account", { pass: await accountPass(mxid) })).body;
  const hostPass = async (mxid = DEV) => (await h.post("/host/pass", { openIdToken: `tok:${mxid}` })).body.pass as string;

  it("B1/B3: a clean game and an excluded game look the same to their players at every step; only the clean one ever makes a code", async () => {
    const clean = await finished();
    const excluded = await finished({ tweak: (s) => { s.highestRungFired = 2; } });
    const replies: unknown[][] = [[], []];
    for (const [i, g] of [clean, excluded].entries()) {
      replies[i].push(await decide(g.A, "status"), await decide(g.A, "yes"), await decide(g.B, "yes"));
    }
    expect(replies[0]).toEqual(replies[1]);
    expect(replies[0]).toEqual([{ view: { state: "ask" } }, { view: { state: "waiting" } }, { view: { state: "waiting" } }]);
    // The delay is drawn for both games, from the same 2–10 minute range.
    const drawn = h.built.share!.drawn;
    expect(drawn.map((d) => d.gameId).sort()).toEqual([clean.gameId, excluded.gameId].sort());
    for (const d of drawn) { expect(d.delayMs).toBeGreaterThanOrEqual(2 * MIN); expect(d.delayMs).toBeLessThanOrEqual(10 * MIN); }
    // Before the delay: the same account rows.
    const before = [await account(`@a1:multiversegames.ai`), await account(`@a2:multiversegames.ai`)];
    expect(before[0].games[0].share).toEqual({ state: "waiting" });
    expect(before[1].games[0].share).toEqual({ state: "waiting" });
    h.clock!.now += 11 * MIN;
    const cleanRow = (await account(`@a1:multiversegames.ai`)).games[0].share;
    expect(cleanRow.state).toBe("code");
    expect(cleanRow.words.split(" ")).toHaveLength(4);
    expect(cleanRow.host).toBe("Robin");
    expect((await account(`@b1:multiversegames.ai`)).games[0].share.words).toBe(cleanRow.words);
    expect((await account(`@a2:multiversegames.ai`)).games[0].share).toEqual({ state: "waiting" });
    h.clock!.now += 15 * DAY;
    expect((await account(`@a2:multiversegames.ai`)).games[0].share).toEqual({ state: "none" });
    expect(await h.repo.hosts.codeByGame(excluded.gameId)).toBeNull();
  });

  const exclusions: Array<[string, (g: { gameId: string }) => Promise<void> | void]> = [
    ["the safety ladder fired (H15)", (g) => { h.built.games.get(g.gameId)!.highestRungFired = 1; }],
    ["a CPS outcome", (g) => { h.built.games.get(g.gameId)!.cpsOutcome = "stay"; }],
    ["a therapy session", (g) => { h.built.games.get(g.gameId)!.therapyMessages = [{ speaker: "therapist", content: "hello" }]; }],
    ["a child-safety case names the game (H1)", (g) => { (h.repo.childSafety as any).cases.set("case-1", { gameRef: g.gameId }); }],
    ["a child-safety hold (H2)", (g) => { markGameHeld(g.gameId); }],
    ["a seat is now a minor", async () => { await h.verify(`@b${n}:multiversegames.ai`, "minor"); }],
    ["a seat is now banned", async () => { await h.repo.childSafety.banIdentifier({ kind: "matrix", value: `@b${n}:multiversegames.ai` }, "t", null); }],
    ["a seat is suspended", async () => { await h.repo.stranger.suspend(await h.stranger.age.subjectHash(`@b${n}:multiversegames.ai`), "t"); }],
    ["the pair is blocked", async (g) => { const r = (await h.repo.stranger.runsForEvent(event.id)).find((x) => x.gameId === g.gameId)!; await h.repo.stranger.addBlock(r.parent1, r.parent2); }],
  ];
  for (const [why, apply] of exclusions) {
    it(`no code when ${why}, and the players can't tell`, async () => {
      const g = await finished();
      await apply(g);
      expect(await decide(g.A, "yes")).toEqual({ view: { state: "waiting" } });
      expect(await decide(g.B, "yes")).toEqual({ view: { state: "waiting" } });
      expect(h.built.share!.drawn.some((d) => d.gameId === g.gameId)).toBe(true);
      h.clock!.now += 11 * MIN;
      expect(await h.repo.hosts.codeByGame(g.gameId)).toBeNull();
    });
  }

  describe("after a restart (no Matrix id in memory for the seats)", () => {
    const restart = () => (h.stranger as any).exchanges.clear();

    it("a seat banned before the restart: no code, and the share step looks like any code-less game", async () => {
      const clean = await finished();
      const banned = await finished();
      await h.repo.childSafety.banIdentifier({ kind: "matrix", value: `@b${n}:multiversegames.ai` }, "t", null);
      restart();
      const replies: unknown[][] = [[], []];
      for (const [i, g] of [clean, banned].entries()) replies[i].push(await decide(g.A, "yes"), await decide(g.B, "yes"));
      expect(replies[0]).toEqual(replies[1]);
      h.clock!.now += 11 * MIN;
      expect(await h.repo.hosts.codeByGame(banned.gameId)).toBeNull();
      expect(await h.repo.hosts.codeByGame(clean.gameId)).not.toBeNull();
    });

    it("a ban list that can't be read: fail closed, no code", async () => {
      const g = await finished();
      restart();
      (h.repo.childSafety as any).bannedValues = async () => { throw new Error("db down"); };
      expect(await decide(g.A, "yes")).toEqual({ view: { state: "waiting" } });
      expect(await decide(g.B, "yes")).toEqual({ view: { state: "waiting" } });
      h.clock!.now += 11 * MIN;
      expect(await h.repo.hosts.codeByGame(g.gameId)).toBeNull();
    });

    it("a seat banned after the code was made: it stops opening, even with nobody seated", async () => {
      const g = await finished();
      await decide(g.A, "yes"); await decide(g.B, "yes");
      h.clock!.now += 11 * MIN;
      const words = (await account(`@a${n}:multiversegames.ai`)).games[0].share.words;
      const pass = await hostPass();
      const { codeRef } = (await h.post("/host/codes/redeem", { pass, words })).body;
      restart();
      await h.repo.childSafety.banIdentifier({ kind: "matrix", value: `@a${n}:multiversegames.ai` }, "t", null);
      expect((await h.post("/host/codes/view", { pass, codeRef })).status).toBe(404);
    });
  });

  it("B2: a phrase from a private talk never reaches a code, nor do the Voices and Quotes sections or the players' names (H5, H9)", async () => {
    const g = await finished({ private: `between us: ${SENTINEL}, ok?` });
    await decide(g.A, "yes"); await decide(g.B, "yes");
    h.clock!.now += 11 * MIN;
    const words = (await account(`@a${n}:multiversegames.ai`)).games[0].share.words;
    const pass = await hostPass();
    const r = await h.post("/host/codes/redeem", { pass, words });
    expect(r.status).toBe(200);
    const view = await h.post("/host/codes/view", { pass, codeRef: r.body.codeRef });
    expect(view.status).toBe(200);
    expect(view.headers.get("cache-control")).toContain("no-store");
    const text = JSON.stringify(view.body.snapshot);
    expect(text).not.toContain("blue heron");
    expect(text).not.toMatch(/Voices in Their Head|Notable Quotes|take up space|be gentle with yourself/);
    expect(text).not.toMatch(/\bAsh\b|\bBea\b/);
    expect(text).toContain("Parent 1");
    expect(text).toContain("garden");
    expect(view.body.watermark).toEqual({ reader: "Robin", openedAt: h.now() });
    // The preview the players see is the same snapshot.
    const preview = (await decide(g.A, "preview")).preview;
    expect(preview).toEqual(view.body.snapshot);
  });

  it("the share step never tells a seat anything about the other seat (H20 / §5.1)", async () => {
    const g = await finished();
    const bHeard: unknown[] = [];
    g.B.socket.on(E.SHARE_STATE, (p: unknown) => bHeard.push(p));
    expect(await decide(g.A, "no")).toEqual({ view: { state: "no" } });
    expect(await decide(g.A, "yes")).toEqual({ view: { state: "no" } }); // final
    await new Promise((r) => setTimeout(r, 100));
    expect(bHeard).toEqual([]);
    expect(await decide(g.B, "status")).toEqual({ view: { state: "ask" } });
    expect(await decide(g.B, "yes")).toEqual({ view: { state: "waiting" } });
    h.clock!.now += 11 * MIN;
    expect(await h.repo.hosts.codeByGame(g.gameId)).toBeNull();
  });

  it("decide later on the account page; the second yes there makes the code", async () => {
    const g = await finished();
    await decide(g.A, "later");
    await decide(g.B, "yes");
    const a = `@a${n}:multiversegames.ai`;
    const pass = await accountPass(a);
    const page = (await h.post("/stranger/account", { pass })).body;
    expect(page.games[0].share).toEqual({ state: "later", until: expect.any(Number) });
    const r = await h.post("/stranger/account/decide", { pass, gameRef: page.games[0].ref, answer: "yes" });
    expect(r.body.share).toEqual({ state: "waiting" });
    h.clock!.now += 11 * MIN;
    expect((await h.post("/stranger/account", { pass })).body.games[0].share.state).toBe("code");
  });

  describe("redeeming", () => {
    async function code() {
      const g = await finished();
      await decide(g.A, "yes"); await decide(g.B, "yes");
      h.clock!.now += 11 * MIN;
      const words = (await account(`@a${n}:multiversegames.ai`)).games[0].share.words as string;
      return { g, words };
    }

    it("code no-tip-off: every failure has the same status, body, and at least the 400ms floor", async () => {
      const { g, words } = await code();
      const devPass = await hostPass();
      const otherPass = await hostPass(OTHER_HOST);
      const failures: Array<{ status: number; text: string; ms: number }> = [];
      const attempt = async (pass: string, w: string) => {
        const t = Date.now();
        const r = await h.post("/host/codes/redeem", { pass, words: w });
        return { status: r.status, text: r.text, ms: Date.now() - t };
      };
      failures.push(await attempt(devPass, "wrong words here please"));
      failures.push(await attempt(devPass, "notaword"));
      failures.push(await attempt(otherPass, words)); // another host's code
      // A stopped code.
      const { words: w2, g: g2 } = await code();
      const a2 = await accountPass(`@a${n}:multiversegames.ai`);
      const ref2 = (await h.post("/stranger/account", { pass: a2 })).body.games[0].ref;
      await h.post("/stranger/account/stop", { pass: a2, gameRef: ref2 });
      failures.push(await attempt(devPass, w2));
      // An expired one (14 days unredeemed).
      h.clock!.now += 15 * DAY;
      failures.push(await attempt(await hostPass(), words));
      for (const f of failures) {
        expect(f.status).toBe(404);
        expect(JSON.parse(f.text)).toEqual({ error: CODE_NOT_AVAILABLE });
        expect(f.ms).toBeGreaterThanOrEqual(390);
      }
      void g; void g2;
    });

    it("the first redemption binds it; access runs 30 days; each opening shows on both players' account pages", async () => {
      const { words } = await code();
      const pass = await hostPass();
      const r = await h.post("/host/codes/redeem", { pass, words });
      expect(r.status).toBe(200);
      expect((await h.post("/host/codes/redeem", { pass, words })).status).toBe(200); // the same reader again
      await h.post("/host/codes/view", { pass, codeRef: r.body.codeRef });
      for (const who of ["a", "b"]) {
        const row = (await account(`@${who}${n}:multiversegames.ai`)).games[0].share;
        expect(row.opened).toEqual([h.now()]);
      }
      h.clock!.now += 31 * DAY;
      expect((await h.post("/host/codes/view", { pass: await hostPass(), codeRef: r.body.codeRef })).status).toBe(404);
    });

    it("a stop is silent to the co-parent, and the host can't open it again", async () => {
      const { words } = await code();
      const pass = await hostPass();
      const { codeRef } = (await h.post("/host/codes/redeem", { pass, words })).body;
      const a = await accountPass(`@a${n}:multiversegames.ai`);
      const ref = (await h.post("/stranger/account", { pass: a })).body.games[0].ref;
      const bBefore = (await account(`@b${n}:multiversegames.ai`)).games[0].share;
      const stopped = await h.post("/stranger/account/stop", { pass: a, gameRef: ref });
      expect(stopped.body.share).toEqual({ state: "stopped", at: h.now() });
      expect((await account(`@b${n}:multiversegames.ai`)).games[0].share).toEqual(bBefore);
      expect((await h.post("/host/codes/view", { pass, codeRef })).status).toBe(404);
    });

    it("a case opened after the code was made stops it; so does the reader being suspended or replaced", async () => {
      const { g, words } = await code();
      const pass = await hostPass();
      const { codeRef } = (await h.post("/host/codes/redeem", { pass, words })).body;
      expect((await h.post("/host/codes/view", { pass, codeRef })).status).toBe(200);
      (h.repo.childSafety as any).cases.set("late", { gameRef: g.gameId });
      expect((await h.post("/host/codes/view", { pass, codeRef })).status).toBe(404);
    });

    it("a case opened after the code appeared, before anyone redeemed it: it never redeems", async () => {
      const { g, words } = await code();
      (h.repo.childSafety as any).cases.set("late2", { gameRef: g.gameId });
      const r = await h.post("/host/codes/redeem", { pass: await hostPass(), words });
      expect([r.status, r.body]).toEqual([404, { error: CODE_NOT_AVAILABLE }]);
    });

    it("the level lowered below 3 after a code was made: it no longer opens", async () => {
      const { words } = await code();
      const pass = await hostPass();
      const { codeRef } = (await h.post("/host/codes/redeem", { pass, words })).body;
      await h.req("PATCH", `/admin/host-tools/events/${event.id}`, { level: 1 }, ADMIN);
      expect((await h.post("/host/codes/view", { pass, codeRef })).status).toBe(404);
      expect((await h.post("/host/codes/redeem", { pass, words })).status).toBe(404);
    });

    it("a reader who is suspended loses the code at once", async () => {
      const { words } = await code();
      const pass = await hostPass();
      const { codeRef } = (await h.post("/host/codes/redeem", { pass, words })).body;
      await h.post(`/admin/host-tools/hosts/${devId}/status`, { status: "suspended" }, ADMIN);
      await h.post(`/admin/host-tools/hosts/${devId}/status`, { status: "approved" }, ADMIN);
      // Re-approved: still the event's host, so it works again; while suspended it didn't.
      expect((await h.post("/host/codes/view", { pass: await hostPass(), codeRef })).status).toBe(200);
      await h.post(`/admin/host-tools/hosts/${devId}/status`, { status: "suspended" }, ADMIN);
      expect((await h.post("/host/codes/view", { pass, codeRef })).status).toBe(401);
    });

    it("rate limit: past 10 an hour, a right code fails like any other", async () => {
      const { words } = await code();
      const pass = await hostPass();
      for (let i = 0; i < 10; i++) await h.post("/host/codes/redeem", { pass, words: `wrong words number ${i}` });
      const r = await h.post("/host/codes/redeem", { pass, words });
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: CODE_NOT_AVAILABLE });
    }, 20_000);
  });

  describe("the account page", () => {
    it("shows only the subject's own rows, by opaque refs (H11); another player's ref does nothing", async () => {
      const g = await finished();
      const a = await accountPass(`@a${n}:multiversegames.ai`);
      const page = (await h.post("/stranger/account", { pass: a })).body;
      const text = JSON.stringify(page);
      expect(text).not.toContain(g.gameId);
      expect(text).not.toMatch(/@[a-z0-9]+:multiversegames/);
      expect(page.games).toHaveLength(1);
      expect(page.games[0].childName).toBeTruthy();
      expect(page.meetups).toHaveLength(1);
      const stranger = await finished();
      const s = await accountPass(`@a${n}:multiversegames.ai`);
      expect((await h.post("/stranger/account/stop", { pass: s, gameRef: page.games[0].ref })).status).toBe(404);
      expect((await h.post("/stranger/share/preview", { pass: s, gameRef: page.games[0].ref })).status).toBe(404);
      void stranger;
    });

    it("an account pass dies with eligibility: a minor result or a revoked stranger pass", async () => {
      await finished();
      const mx = `@a${n}:multiversegames.ai`;
      const pass = await accountPass(mx);
      expect((await h.post("/stranger/account", { pass })).status).toBe(200);
      await h.verify(mx, "minor");
      expect((await h.post("/stranger/account", { pass })).status).toBe(401);
      const mx2 = `@b${n}:multiversegames.ai`;
      const pass2 = await accountPass(mx2);
      h.stranger.passes.revokeSubject(mx2);
      expect((await h.post("/stranger/account", { pass: pass2 })).status).toBe(401);
    });

    it("forget a meetup: it leaves the list", async () => {
      await finished();
      const pass = await accountPass(`@a${n}:multiversegames.ai`);
      const ref = (await h.post("/stranger/account", { pass })).body.meetups[0].ref;
      expect((await h.post("/stranger/account/forget-meetup", { pass, eventRef: ref })).status).toBe(200);
      expect((await h.post("/stranger/account", { pass })).body.meetups).toEqual([]);
    });
  });

  it("with host tools off, the account, preview and code routes answer like paths that were never built", async () => {
    h.hostCfg.enabled = false;
    const never = await h.post("/never-built-path", {});
    for (const path of ["/stranger/account", "/stranger/account/pass", "/stranger/share/preview", "/host/codes/redeem", "/host/codes/view"]) {
      const r = await h.post(path, {});
      expect([r.status, r.text]).toEqual([never.status, never.text]);
    }
  });
});
