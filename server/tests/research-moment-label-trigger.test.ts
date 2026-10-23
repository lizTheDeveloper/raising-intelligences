import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { MockLLMClient } from "../src/llm/mock.js";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { createGame } from "../src/game/state-machine.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { buildServer, type BuiltServer } from "../src/app.js";
import { QUESTION_BANK } from "../src/research/questions.js";
import { cleanUntrustedText } from "../src/research/sanitize.js";
import {
  labelMoment,
  labelHopeFromAnswer,
  recordSceneSummary,
  peekSceneSummary,
  forgetSceneSummary,
} from "../src/research/moment-label.js";
import type { GameEvent } from "../src/types.js";

const MOMENT_Q = QUESTION_BANK.find((q) => q.kind === "about_moment")!;
const event: GameEvent = { eventNumber: 1, age: 4, description: "Your child is 4.", setting: "Kitchen", trigger: "Spill" };

class LabelLLM extends MockLLMClient {
  public labelReply = '{"label":"match","rationale":"ok"}';
  public labelCalls: string[] = [];
  public failSummarizer = false;
  async completeResponse(...args: Parameters<MockLLMClient["completeResponse"]>): Promise<string> {
    if (args[3] === "moment_comparison") {
      this.labelCalls.push(args[1]);
      return this.labelReply;
    }
    if (args[3] === "memory_summarizer" && this.failSummarizer) throw new Error("down");
    return super.completeResponse(...args);
  }
}
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("parser: first balanced JSON object", () => {
  const run = async (reply: string) => {
    const llm = new LabelLLM();
    llm.labelReply = reply;
    return labelMoment(llm, { kind: "hope_vs_kept", hoped: "h", repair: null, memorySummary: "m" });
  };
  it("prose before and after", async () => {
    expect((await run('Let me think. {"label":"partial","rationale":"half"} Hope that helps.')).label).toBe("partial");
  });
  it("fenced JSON", async () => {
    expect((await run('```json\n{"label":"match","rationale":"x"}\n```')).label).toBe("match");
  });
  it("nested braces and quotes in the rationale", async () => {
    const out = await run('{"label":"mismatch","rationale":"said {sorry} and \\"}\\" later"}');
    expect(out.label).toBe("mismatch");
    expect(out.rationale).toContain("{sorry}");
  });
  it("two objects: takes the first", async () => {
    expect((await run('{"label":"match","rationale":"a"} {"label":"mismatch","rationale":"b"}')).label).toBe("match");
  });
  it("first object invalid stays unclear (does not skip ahead)", async () => {
    expect((await run('{"label":"nope"} {"label":"match"}')).label).toBe("unclear");
  });
  it.each(["garbage", "{unterminated", "} {", "", "{}"])("garbage %j is unclear", async (g) => {
    expect((await run(g)).label).toBe("unclear");
  });
});

describe("sanitizer tokens", () => {
  it("removes PARENT_TEXT / CHILD_MEMORY alone, case-insensitively and when recombined", () => {
    const opt = { neutralizeDelimiters: true };
    expect(cleanUntrustedText("a PARENT_TEXT b", 100, opt)).toBe("a b");
    expect(cleanUntrustedText("a child_memory b", 100, opt)).toBe("a b");
    expect(cleanUntrustedText("a Parent_Text b", 100, opt)).toBe("a b");
    expect(cleanUntrustedText("xPARENT_PARENT_TEXTTEXTx", 100, opt)).toBe("xx");
    expect(cleanUntrustedText("CHILD_CHILD_MEMORYMEMORY", 100, opt)).toBe("");
  });
});

describe("dual trigger (endFamilyChat + answer)", () => {
  const saved = process.env.RI_RESEARCH_ENABLED;
  let repo: InMemoryGameRepository;
  let llm: LabelLLM;
  let engine: ConversationEngine;
  beforeEach(() => {
    process.env.RI_RESEARCH_ENABLED = "true";
    repo = new InMemoryGameRepository();
    llm = new LabelLLM();
    llm.events = [event];
    engine = new ConversationEngine(llm);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.RI_RESEARCH_ENABLED; else process.env.RI_RESEARCH_ENABLED = saved;
  });

  async function game(adult: boolean | null = true) {
    llm.events = [event];
    const state = await engine.startEvent(createGame("Kai"));
    state.currentEventNumber = 1;
    await repo.saveGame(state);
    if (adult !== null) await repo.recordAge(state.id, { birthYear: adult ? 1985 : null, isAdult: adult });
    return state;
  }
  const answer = (gameId: string, scene: number, text: string | null, skipped = false) =>
    repo.saveAnswer({ gameId, sceneIndex: scene, questionId: MOMENT_Q.id, questionVersion: 1, kind: "about_moment", answer: text, skipped, shownAt: 1, answeredAt: 2 });

  it("an answer saved after endFamilyChat read answers is labeled by the answer-side trigger", async () => {
    const state = await game();
    await engine.endFamilyChat(state, undefined, undefined, repo);
    await flush();
    expect(await repo.listMomentLabels(state.id)).toEqual([]); // nothing to label yet
    await answer(state.id, 1, "late hope");
    await labelHopeFromAnswer(llm, repo, state.id, 1);
    expect((await repo.listMomentLabels(state.id)).map((l) => l.kind)).toEqual(["hope_vs_kept"]);
    expect(llm.labelCalls[0]).toContain("late hope");
  });

  it("an answer saved before is labeled by endFamilyChat; a later trigger only upserts the same row", async () => {
    const state = await game();
    await answer(state.id, 1, "early hope");
    await engine.endFamilyChat(state, undefined, undefined, repo);
    await flush();
    await labelHopeFromAnswer(llm, repo, state.id, 1);
    expect(await repo.listMomentLabels(state.id)).toHaveLength(1);
  });

  it("records the scene summary before reading answers, and only this scene's own text", async () => {
    const state = await game();
    await engine.endFamilyChat(state, undefined, undefined, repo);
    expect(peekSceneSummary(state.id)?.sceneIndex).toBe(1);
  });

  it("a summarizer-failed scene records nothing, so a late answer is not labeled against a carried-over summary", async () => {
    const state = await game();
    state.memorySummary = "PREVIOUS SCENE SUMMARY";
    llm.failSummarizer = true;
    await engine.endFamilyChat(state, undefined, undefined, repo);
    expect(peekSceneSummary(state.id)).toBeUndefined();
    await answer(state.id, 1, "hope");
    await labelHopeFromAnswer(llm, repo, state.id, 1);
    expect(llm.labelCalls).toHaveLength(0);
    expect(await repo.listMomentLabels(state.id)).toEqual([]);
  });

  it("a record for another scene does not label", async () => {
    const state = await game();
    recordSceneSummary(state.id, 1, "summary");
    await answer(state.id, 2, "hope");
    await labelHopeFromAnswer(llm, repo, state.id, 2);
    expect(llm.labelCalls).toHaveLength(0);
  });

  it("the next scene's record replaces the previous one", () => {
    recordSceneSummary("g-x", 1, "a");
    recordSceneSummary("g-x", 2, "b");
    expect(peekSceneSummary("g-x")).toMatchObject({ sceneIndex: 2 });
    forgetSceneSummary("g-x");
  });

  it("ineligible games never label via the answer trigger", async () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ["under-18", async () => (await game(false)).id],
      ["legacy", async () => (await game(null)).id],
      ["seated", async () => { const s = await game(); await repo.savePlayer(s.id, "parent1", "A", "t"); return s.id; }],
    ];
    for (const [name, make] of cases) {
      const id = await make();
      recordSceneSummary(id, 1, "summary");
      await answer(id, 1, "hope");
      await labelHopeFromAnswer(llm, repo, id, 1);
      expect(llm.labelCalls, name).toHaveLength(0);
      expect(await repo.listMomentLabels(id), name).toEqual([]);
    }
    const flagOff = await game();
    recordSceneSummary(flagOff.id, 1, "summary");
    await answer(flagOff.id, 1, "hope");
    delete process.env.RI_RESEARCH_ENABLED;
    await labelHopeFromAnswer(llm, repo, flagOff.id, 1);
    expect(llm.labelCalls).toHaveLength(0);
  });

  it("a skipped answer does not label", async () => {
    const state = await game();
    recordSceneSummary(state.id, 1, "summary");
    await answer(state.id, 1, null, true);
    await labelHopeFromAnswer(llm, repo, state.id, 1);
    expect(llm.labelCalls).toHaveLength(0);
  });

  it("flag-off games record nothing in endFamilyChat", async () => {
    const state = await game();
    delete process.env.RI_RESEARCH_ENABLED;
    await engine.endFamilyChat(state, undefined, undefined, repo);
    expect(peekSceneSummary(state.id)).toBeUndefined();
  });

  it("after the game is deleted the record is gone and a late trigger writes nothing", async () => {
    const state = await game();
    recordSceneSummary(state.id, 1, "summary");
    await answer(state.id, 1, "hope");
    await repo.deleteGameData(state.id);
    forgetSceneSummary(state.id);
    expect(peekSceneSummary(state.id)).toBeUndefined();
    await labelHopeFromAnswer(llm, repo, state.id, 1);
    expect(await repo.listMomentLabels(state.id)).toEqual([]);
    // Even with a stale record, the deleted game stays deleted.
    recordSceneSummary(state.id, 1, "summary");
    await labelHopeFromAnswer(llm, repo, state.id, 1);
    expect(await repo.listMomentLabels(state.id)).toEqual([]);
    forgetSceneSummary(state.id);
  });
});

describe("answers route + DELETE trigger wiring", () => {
  const saved = process.env.RI_RESEARCH_ENABLED;
  let built: BuiltServer;
  let base: string;
  let repo: InMemoryGameRepository;
  let llm: LabelLLM;
  let ip = 0;
  beforeAll(async () => {
    process.env.RI_RESEARCH_ENABLED = "true";
    repo = new InMemoryGameRepository();
    llm = new LabelLLM();
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
  const post = (g: { gameId: string; secret: string }, body: unknown) =>
    fetch(`${base}/game/${g.gameId}/answers`, { method: "POST", headers: { "Content-Type": "application/json", "x-game-secret": g.secret }, body: JSON.stringify(body) });
  const body = (extra: object = {}) => ({ questionId: MOMENT_Q.id, version: MOMENT_Q.version, sceneIndex: 0, answer: "route hope", shownAt: 1, ...extra });

  it("labels after the answer is stored when a record exists for that scene", async () => {
    const g = await make();
    recordSceneSummary(g.gameId, 0, "I kept it");
    expect((await post(g, body())).status).toBe(204);
    await flush();
    expect((await repo.listMomentLabels(g.gameId)).map((l) => l.kind)).toEqual(["hope_vs_kept"]);
  });
  it("a skip, or no record, labels nothing", async () => {
    const g = await make();
    expect((await post(g, body())).status).toBe(204); // no record
    await flush();
    expect(await repo.listMomentLabels(g.gameId)).toEqual([]);
    recordSceneSummary(g.gameId, 0, "I kept it");
    await post(g, body({ skipped: true, answer: undefined }));
    await flush();
    expect(await repo.listMomentLabels(g.gameId)).toEqual([]);
  });
  it("DELETE /game/:id forgets the record", async () => {
    const g = await make();
    recordSceneSummary(g.gameId, 0, "I kept it");
    const res = await fetch(`${base}/game/${g.gameId}`, { method: "DELETE", headers: { "x-game-secret": g.secret } });
    expect(res.status).toBe(204);
    expect(peekSceneSummary(g.gameId)).toBeUndefined();
  });
});
