import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { MockLLMClient } from "../src/llm/mock.js";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { createGame } from "../src/game/state-machine.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { buildServer, type BuiltServer } from "../src/app.js";
import { QUESTION_BANK } from "../src/research/questions.js";
import {
  labelHopeFromAnswer,
  labelSceneMoments,
  recordSceneSummary,
  forgetSceneSummary,
  claimedLabelCount,
} from "../src/research/moment-label.js";
import type { GameEvent } from "../src/types.js";

const MOMENT_Q = QUESTION_BANK.find((q) => q.kind === "about_moment")!;
const event: GameEvent = { eventNumber: 1, age: 4, description: "Your child is 4.", setting: "Kitchen", trigger: "Spill" };
const flush = () => new Promise((r) => setTimeout(r, 40));

class CountingLLM extends MockLLMClient {
  public labelCalls = 0;
  public reply = '{"label":"match","rationale":"ok"}';
  async completeResponse(...args: Parameters<MockLLMClient["completeResponse"]>): Promise<string> {
    if (args[3] === "moment_comparison") {
      this.labelCalls++;
      if (this.reply === "throw") throw new Error("boom");
      return this.reply;
    }
    return super.completeResponse(...args);
  }
}

describe("each scene is labeled once", () => {
  const saved = process.env.RI_RESEARCH_ENABLED;
  let repo: InMemoryGameRepository;
  let llm: CountingLLM;
  let engine: ConversationEngine;
  beforeEach(() => {
    process.env.RI_RESEARCH_ENABLED = "true";
    repo = new InMemoryGameRepository();
    llm = new CountingLLM();
    engine = new ConversationEngine(llm);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.RI_RESEARCH_ENABLED; else process.env.RI_RESEARCH_ENABLED = saved;
  });
  async function game() {
    llm.events = [event];
    const state = await engine.startEvent(createGame("Kai"));
    state.currentEventNumber = 1;
    await repo.saveGame(state);
    await repo.recordAge(state.id, { birthYear: 1985, isAdult: true });
    return state;
  }
  const answer = (gameId: string, text: string, answeredAt = 2) =>
    repo.saveAnswer({ gameId, sceneIndex: 1, questionId: MOMENT_Q.id, questionVersion: 1, kind: "about_moment", answer: text, skipped: false, shownAt: 1, answeredAt });

  it("20 identical triggers make one labeler call", async () => {
    const s = await game();
    recordSceneSummary(s.id, 1, "summary");
    await answer(s.id, "hope");
    for (let i = 0; i < 20; i++) await labelHopeFromAnswer(llm, repo, s.id, 1);
    expect(llm.labelCalls).toBe(1);
    forgetSceneSummary(s.id);
  });

  it("concurrent triggers make one labeler call", async () => {
    const s = await game();
    recordSceneSummary(s.id, 1, "summary");
    await answer(s.id, "hope");
    await Promise.all(Array.from({ length: 5 }, () => labelHopeFromAnswer(llm, repo, s.id, 1)));
    expect(llm.labelCalls).toBe(1);
    forgetSceneSummary(s.id);
  });

  it("an answer arriving after endFamilyChat already labeled the scene does not relabel", async () => {
    const s = await game();
    await answer(s.id, "early hope");
    await engine.endFamilyChat(s, undefined, undefined, repo);
    await flush();
    expect(llm.labelCalls).toBe(1);
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    expect(llm.labelCalls).toBe(1);
    forgetSceneSummary(s.id);
  });

  it("endFamilyChat after the route already labeled does not relabel", async () => {
    const s = await game();
    recordSceneSummary(s.id, 1, "summary");
    await answer(s.id, "hope");
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    expect(llm.labelCalls).toBe(1);
    await labelSceneMoments(llm, repo, { id: s.id, currentEventNumber: 1 }, "summary");
    expect(llm.labelCalls).toBe(1);
    forgetSceneSummary(s.id);
  });

  it("a changed answer after labeling does not relabel (first answer wins)", async () => {
    const s = await game();
    recordSceneSummary(s.id, 1, "summary");
    await answer(s.id, "first");
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    await answer(s.id, "second", 3);
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    expect(llm.labelCalls).toBe(1);
    forgetSceneSummary(s.id);
  });

  it("a failed first call keeps the claim: no retry", async () => {
    const s = await game();
    recordSceneSummary(s.id, 1, "summary");
    await answer(s.id, "hope");
    llm.reply = "throw";
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    expect(llm.labelCalls).toBe(1);
    forgetSceneSummary(s.id);
  });

  it("a side without both inputs does not claim: the other side still fires", async () => {
    const s = await game();
    await labelHopeFromAnswer(llm, repo, s.id, 1); // no record, no answer
    await answer(s.id, "hope");
    await labelHopeFromAnswer(llm, repo, s.id, 1); // answer but no record
    expect(llm.labelCalls).toBe(0);
    recordSceneSummary(s.id, 1, "summary");
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    expect(llm.labelCalls).toBe(1);
    forgetSceneSummary(s.id);
  });

  it("an existing label row (e.g. after a restart) is not relabeled", async () => {
    const s = await game();
    await repo.saveMomentLabel(s.id, 1, { kind: "hope_vs_kept", label: "match", rationale: "" });
    recordSceneSummary(s.id, 1, "summary");
    await answer(s.id, "hope");
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    expect(llm.labelCalls).toBe(0);
    forgetSceneSummary(s.id);
  });

  it("claims are cleared with the game and the claim set is bounded", async () => {
    const s = await game();
    recordSceneSummary(s.id, 1, "summary");
    await answer(s.id, "hope");
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    const before = claimedLabelCount();
    forgetSceneSummary(s.id);
    expect(claimedLabelCount()).toBe(before - 1);
    for (let i = 0; i < 3000; i++) {
      const id = `bulk-${i}`;
      recordSceneSummary(id, 1, "x");
      await repo.saveGame({ ...s, id });
      await repo.recordAge(id, { birthYear: 1985, isAdult: true });
      await repo.saveAnswer({ gameId: id, sceneIndex: 1, questionId: MOMENT_Q.id, questionVersion: 1, kind: "about_moment", answer: "h", skipped: false, shownAt: 1, answeredAt: 2 });
      await labelHopeFromAnswer(llm, repo, id, 1);
    }
    expect(claimedLabelCount()).toBeLessThanOrEqual(2000);
  });

  it("eligibility gates still apply", async () => {
    const s = await game();
    await repo.recordAge(s.id, { birthYear: null, isAdult: false });
    recordSceneSummary(s.id, 1, "summary");
    await answer(s.id, "hope");
    await labelHopeFromAnswer(llm, repo, s.id, 1);
    expect(llm.labelCalls).toBe(0);
    forgetSceneSummary(s.id);
  });
});

describe("answers route: one label per scene, rate limited", () => {
  const saved = process.env.RI_RESEARCH_ENABLED;
  let built: BuiltServer;
  let base: string;
  let repo: InMemoryGameRepository;
  let llm: CountingLLM;
  let ip = 0;
  beforeAll(async () => {
    process.env.RI_RESEARCH_ENABLED = "true";
    repo = new InMemoryGameRepository();
    llm = new CountingLLM();
    built = buildServer({ llm, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => built.httpServer.close(() => r()));
    if (saved === undefined) delete process.env.RI_RESEARCH_ENABLED; else process.env.RI_RESEARCH_ENABLED = saved;
  });
  async function make() {
    const res = await fetch(`${base}/game`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `192.0.2.${++ip}` }, body: JSON.stringify({ childName: "Kai", birthYear: 1985 }) });
    return (await res.json()) as { gameId: string; secret: string };
  }
  const post = (g: { gameId: string; secret: string }, clientIp: string, answer = "route hope") =>
    fetch(`${base}/game/${g.gameId}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-game-secret": g.secret, "X-Forwarded-For": clientIp },
      body: JSON.stringify({ questionId: MOMENT_Q.id, version: MOMENT_Q.version, sceneIndex: 0, answer, shownAt: 1 }),
    });

  it("20 identical POSTs, even concurrent, produce exactly one labeler call", async () => {
    const g = await make();
    recordSceneSummary(g.gameId, 0, "I kept it");
    llm.labelCalls = 0;
    const rs = await Promise.all(Array.from({ length: 20 }, () => post(g, "198.18.0.1")));
    expect(rs.every((r) => r.status === 204)).toBe(true);
    await flush();
    expect(llm.labelCalls).toBe(1);
  });

  it("a burst beyond the limit gets 429; two answers in a scene are unaffected", async () => {
    const g = await make();
    const normal = [await post(g, "198.18.0.2", "a"), await post(g, "198.18.0.2", "b")];
    expect(normal.map((r) => r.status)).toEqual([204, 204]);
    const statuses: number[] = [];
    for (let i = 0; i < 80; i++) statuses.push((await post(g, "198.18.0.3")).status);
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(204);
  });
});

describe("Pg hasMomentLabel (mock db)", () => {
  it("selects by the unique key", async () => {
    const { PgGameRepository } = await import("../src/db/repository.js");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const repo = new PgGameRepository({
      query: async (sql: string, params: unknown[]) => { calls.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [{}] }; },
    } as never);
    expect(await repo.hasMomentLabel("g", 2, "hope_vs_kept")).toBe(true);
    expect(calls[0].sql).toMatch(/FROM moment_labels WHERE game_id = \$1 AND scene_index = \$2 AND kind = \$3/);
    expect(calls[0].params).toEqual(["g", 2, "hope_vs_kept"]);
  });
});
