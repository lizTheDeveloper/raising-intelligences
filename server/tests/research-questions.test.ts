import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository, PgGameRepository } from "../src/db/repository.js";
import { QUESTION_BANK, selectQuestions, type Question } from "../src/research/questions.js";
import type { StoredAnswer } from "../src/research/questions.js";

const TAP_Q = QUESTION_BANK.find((q) => q.answer.type === "tap")!;
const TEXT_Q = QUESTION_BANK.find((q) => q.answer.type === "text" && q.kind === "about_you")!;
const MOMENT_Q = QUESTION_BANK.find((q) => q.kind === "about_moment")!;

describe("QUESTION_BANK", () => {
  it("has the five placeholder questions, no scale items, unique ids", () => {
    expect(QUESTION_BANK).toHaveLength(5);
    expect(QUESTION_BANK.some((q) => q.kind === "scale")).toBe(false);
    expect(new Set(QUESTION_BANK.map((q) => q.id)).size).toBe(5);
    expect(MOMENT_Q.waits).toEqual(["post_scene"]);
    expect(MOMENT_Q.answer).toEqual({ type: "text", maxLength: 300 });
  });
});

describe("selectQuestions", () => {
  const bank: Question[] = [
    { id: "a", version: 1, kind: "about_you", prompt: "a", waits: ["first"], answer: { type: "text", maxLength: 10 } },
    { id: "b", version: 1, kind: "about_you", prompt: "b", waits: ["first", "next_scene"], answer: { type: "text", maxLength: 10 } },
    { id: "s1", version: 1, kind: "scale", prompt: "s", waits: ["first"], answer: { type: "tap", options: [{ value: "1", label: "1" }] } },
    { id: "s2", version: 1, kind: "scale", prompt: "s", waits: ["first"], licenseCleared: true, answer: { type: "tap", options: [{ value: "1", label: "1" }] } },
    { id: "c", version: 1, kind: "about_you", prompt: "c", waits: ["post_scene"], answer: { type: "text", maxLength: 10 } },
  ];
  it("keeps bank order, filters by wait, excludes answered and unlicensed scale", () => {
    const ids = (a: Question[]) => a.map((q) => q.id);
    expect(ids(selectQuestions({ wait: "first", answeredIds: new Set(), limit: 10, bank }))).toEqual(["a", "b", "s2"]);
    expect(ids(selectQuestions({ wait: "first", answeredIds: new Set(["a"]), limit: 10, bank }))).toEqual(["b", "s2"]);
    expect(ids(selectQuestions({ wait: "first", answeredIds: new Set(), limit: 1, bank }))).toEqual(["a"]);
    expect(ids(selectQuestions({ wait: "post_scene", answeredIds: new Set(), limit: 10, bank }))).toEqual(["c"]);
  });
  it("uses QUESTION_BANK by default", () => {
    expect(selectQuestions({ wait: "post_scene", answeredIds: new Set(), limit: 10 }).map((q) => q.id)).toContain(MOMENT_Q.id);
  });
});

describe("InMemory answers", () => {
  it("rejects an answer for a game that does not exist, like the Postgres foreign key", async () => {
    const repo = new InMemoryGameRepository();
    await expect(repo.saveAnswer({
      gameId: "nope", sceneIndex: 1, questionId: "q", questionVersion: 1, kind: "about_you",
      answer: "x", skipped: false, shownAt: 1, answeredAt: 2,
    })).rejects.toThrow(/does not exist/);
  });
  const a = (over: Partial<StoredAnswer> = {}): StoredAnswer => ({
    gameId: "g1", sceneIndex: 1, questionId: "q", questionVersion: 1, kind: "about_you",
    answer: "x", skipped: false, shownAt: 1, answeredAt: 2, ...over,
  });
  it("upserts on (game, scene, question) and is wiped by deleteGameData", async () => {
    const repo = new InMemoryGameRepository();
    const mk = (id: string) => ({ id, sidebarUsed: {}, therapyMessages: [] }) as never;
    await repo.saveGame(mk("g1"));
    await repo.saveGame(mk("g2"));
    await repo.saveAnswer(a());
    await repo.saveAnswer(a({ answer: "y" }));
    await repo.saveAnswer(a({ sceneIndex: 2 }));
    await repo.saveAnswer(a({ gameId: "g2" }));
    expect(await repo.listAnswers("g1")).toHaveLength(2);
    await repo.deleteGameData("g1");
    expect(await repo.listAnswers("g1")).toEqual([]);
    expect(await repo.listAnswers("g2")).toHaveLength(1);
  });
});

describe("PgGameRepository answers (mock db)", () => {
  it("saveAnswer upserts with answer as JSON", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const repo = new PgGameRepository({
      query: async (sql: string, params: unknown[]) => { calls.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [] }; },
    } as never);
    await repo.saveAnswer({ gameId: "g", sceneIndex: 3, questionId: "q", questionVersion: 2, kind: "about_you", answer: { v: 1 }, skipped: false, shownAt: 10, answeredAt: 20 });
    expect(calls[0].sql).toMatch(/INSERT INTO question_answers/);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(game_id, scene_index, question_id\) DO UPDATE/);
    expect(calls[0].sql).toContain("WHERE question_answers.skipped OR NOT EXCLUDED.skipped");
    expect(calls[0].params).toContain(JSON.stringify({ v: 1 }));
  });
  it("listAnswers maps rows", async () => {
    const repo = new PgGameRepository({
      query: async () => ({ rows: [{ game_id: "g", scene_index: 3, question_id: "q", question_version: 2, kind: "about_you", answer: "hi", skipped: false, shown_at: "10", answered_at: "20" }] }),
    } as never);
    expect(await repo.listAnswers("g")).toEqual([
      { gameId: "g", sceneIndex: 3, questionId: "q", questionVersion: 2, kind: "about_you", answer: "hi", skipped: false, shownAt: 10, answeredAt: 20 },
    ]);
  });
  it("deleteGameData removes question_answers inside the transaction", async () => {
    const calls: string[] = [];
    const client = { query: async (s: string) => { calls.push(s.replace(/\s+/g, " ").trim()); return { rows: [] }; }, release: () => {} };
    const repo = new PgGameRepository({ query: async () => ({ rows: [] }), connect: async () => client } as never);
    await repo.deleteGameData("g");
    const i = calls.findIndex((c) => c.startsWith("DELETE FROM question_answers"));
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(calls.findIndex((c) => c.startsWith("DELETE FROM games")));
  });
});

describe("research routes", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let repo: InMemoryGameRepository;
  const saved = process.env.RI_RESEARCH_ENABLED;

  beforeAll(async () => {
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: new MockLLMClient(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => built.httpServer.close(() => r()));
  });
  beforeEach(() => { process.env.RI_RESEARCH_ENABLED = "true"; });
  afterEach(() => {
    if (saved === undefined) delete process.env.RI_RESEARCH_ENABLED; else process.env.RI_RESEARCH_ENABLED = saved;
  });

  const headers = { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.50" };
  let ipCounter = 0;
  async function makeGame(birthYear?: number): Promise<{ gameId: string; secret: string }> {
    // Fresh IP per game: game creation is rate limited per IP.
    const res = await fetch(`${baseUrl}/game`, {
      method: "POST", headers: { ...headers, "X-Forwarded-For": `198.51.100.${++ipCounter}` },
      body: JSON.stringify({ childName: "Kai", ...(birthYear !== undefined ? { birthYear } : {}) }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { gameId: string; secret: string };
  }
  const adult = () => makeGame(1985);
  const post = (id: string, body: unknown, secret?: string) =>
    fetch(`${baseUrl}/game/${id}/answers`, {
      method: "POST",
      headers: { ...headers, ...(secret ? { "x-game-secret": secret } : {}) },
      body: JSON.stringify(body),
    });
  const get = (id: string, wait: string, secret?: string) =>
    fetch(`${baseUrl}/game/${id}/questions?wait=${wait}`, { headers: secret ? { "x-game-secret": secret } : {} });
  const valid = (over: Record<string, unknown> = {}) => ({
    questionId: TAP_Q.id, version: TAP_Q.version, sceneIndex: 0,
    answer: (TAP_Q.answer as { options: { value: string }[] }).options[0].value, shownAt: Date.now(), ...over,
  });

  describe("forged requests write nothing", () => {
    it("no secret / wrong secret are 403 regardless of other state", async () => {
      const g = await adult();
      for (const s of [undefined, "0".repeat(64)]) {
        expect((await post(g.gameId, valid(), s)).status).toBe(403);
        expect((await get(g.gameId, "first", s)).status).toBe(403);
      }
      // 403 even when research is disabled or the game is under 18
      const minor = await makeGame(new Date().getFullYear() - 10);
      process.env.RI_RESEARCH_ENABLED = "false";
      expect((await post(g.gameId, valid())).status).toBe(403);
      expect((await get(g.gameId, "first")).status).toBe(403);
      process.env.RI_RESEARCH_ENABLED = "true";
      expect((await post(minor.gameId, valid())).status).toBe(403);
      expect(await repo.listAnswers(g.gameId)).toEqual([]);
    });
    it("under-18 game is 404 and writes nothing", async () => {
      const m = await makeGame(new Date().getFullYear() - 10);
      expect((await post(m.gameId, valid(), m.secret)).status).toBe(404);
      const r = await get(m.gameId, "first", m.secret);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "Not available" });
      expect(await repo.listAnswers(m.gameId)).toEqual([]);
    });
    it("legacy game (no age record) is 404 and writes nothing", async () => {
      const g = await makeGame();
      expect((await post(g.gameId, valid(), g.secret)).status).toBe(404);
      expect((await get(g.gameId, "first", g.secret)).status).toBe(404);
      expect(await repo.listAnswers(g.gameId)).toEqual([]);
    });
    it("research disabled is 404 and writes nothing", async () => {
      const g = await adult();
      process.env.RI_RESEARCH_ENABLED = "false";
      const p = await post(g.gameId, valid(), g.secret);
      expect(p.status).toBe(404);
      expect(await p.json()).toEqual({ error: "Not available" });
      expect((await get(g.gameId, "first", g.secret)).status).toBe(404);
      expect(await repo.listAnswers(g.gameId)).toEqual([]);
    });
    it("unknown game id is 403", async () => {
      expect((await post("00000000-0000-4000-8000-000000000000", valid(), "x")).status).toBe(403);
    });
  });

  describe("GET /questions", () => {
    it("returns at most 2, then excludes answered and skipped ids", async () => {
      const g = await adult();
      const first = (await (await get(g.gameId, "first", g.secret)).json()) as { questions: Question[] };
      expect(first.questions.length).toBe(2);
      const [q1, q2] = first.questions;
      const opt = (q1.answer as { options: { value: string }[] }).options?.[0]?.value ?? "hello";
      expect((await post(g.gameId, { questionId: q1.id, version: q1.version, sceneIndex: 0, answer: opt, shownAt: 1 }, g.secret)).status).toBe(204);
      expect((await post(g.gameId, { questionId: q2.id, version: q2.version, sceneIndex: 0, skipped: true, shownAt: 1 }, g.secret)).status).toBe(204);
      const next = (await (await get(g.gameId, "first", g.secret)).json()) as { questions: Question[] };
      const ids = next.questions.map((q) => q.id);
      expect(ids).not.toContain(q1.id);
      expect(ids).not.toContain(q2.id);
    });
    it("returns [] when nothing is left or the wait has none", async () => {
      const g = await adult();
      const r = (await (await get(g.gameId, "next_scene", g.secret)).json()) as { questions: Question[] };
      expect(r.questions.every((q) => q.waits.includes("next_scene"))).toBe(true);
      for (const q of QUESTION_BANK) {
        const a = q.answer.type === "tap" ? q.answer.options[0].value : "hi";
        await post(g.gameId, { questionId: q.id, version: q.version, sceneIndex: 0, answer: a, shownAt: 1 }, g.secret);
      }
      expect(await (await get(g.gameId, "first", g.secret)).json()).toEqual({ questions: [] });
    });
    it("repeats about_moment per scene but asks about_you once per game", async () => {
      const g = await adult();
      built.games.set(g.gameId, { ...built.games.get(g.gameId)!, currentEventNumber: 2 });
      const ids = async (wait: string, scene?: number) =>
        ((await (await fetch(`${baseUrl}/game/${g.gameId}/questions?wait=${wait}${scene === undefined ? "" : `&sceneIndex=${scene}`}`, { headers: { "x-game-secret": g.secret } })).json()) as { questions: Question[] }).questions.map((q) => q.id);
      expect(await ids("post_scene", 1)).toContain(MOMENT_Q.id);
      await post(g.gameId, valid({ questionId: MOMENT_Q.id, version: MOMENT_Q.version, sceneIndex: 1, answer: "kindness" }), g.secret);
      expect(await ids("post_scene", 1)).not.toContain(MOMENT_Q.id);
      expect(await ids("post_scene", 2)).toContain(MOMENT_Q.id);
      expect(await ids("post_scene")).toContain(MOMENT_Q.id); // default = currentEventNumber (2)
      const opt = (TAP_Q.answer as { options: { value: string }[] }).options[0].value;
      await post(g.gameId, valid({ sceneIndex: 1, answer: opt }), g.secret);
      expect(await ids("first", 2)).not.toContain(TAP_Q.id);
      expect(await ids("first", 1)).not.toContain(TAP_Q.id);
    });
    it("rejects an invalid sceneIndex with 400", async () => {
      const g = await adult();
      for (const v of ["abc", "-1", "1.5", "99", ""]) {
        const r = await fetch(`${baseUrl}/game/${g.gameId}/questions?wait=first&sceneIndex=${v}`, { headers: { "x-game-secret": g.secret } });
        expect(r.status, v).toBe(400);
      }
    });
    it("rejects an invalid wait with 400", async () => {
      const g = await adult();
      expect((await get(g.gameId, "bogus", g.secret)).status).toBe(400);
    });
  });

  describe("POST /answers", () => {
    it("stores a tap answer and round-trips through listAnswers", async () => {
      const g = await adult();
      const res = await post(g.gameId, valid(), g.secret);
      expect(res.status).toBe(204);
      const [row] = await repo.listAnswers(g.gameId);
      expect(row).toMatchObject({ gameId: g.gameId, sceneIndex: 0, questionId: TAP_Q.id, questionVersion: TAP_Q.version, kind: TAP_Q.kind, skipped: false });
      expect(row.answer).toBe((TAP_Q.answer as { options: { value: string }[] }).options[0].value);
    });
    it("stores text trimmed, control-stripped and capped", async () => {
      const g = await adult();
      const cap = (TEXT_Q.answer as { maxLength: number }).maxLength;
      const raw = `  hi\u0000 there\u0007${"x".repeat(cap + 50)}  `;
      expect((await post(g.gameId, valid({ questionId: TEXT_Q.id, version: TEXT_Q.version, answer: raw }), g.secret)).status).toBe(204);
      const [row] = await repo.listAnswers(g.gameId);
      expect(typeof row.answer).toBe("string");
      expect((row.answer as string).startsWith("hi there")).toBe(true);
      expect((row.answer as string).length).toBe(cap);
      expect(row.answer).not.toMatch(/[\u0000-\u001f]/);
    });
    it("turns newlines/tabs into single spaces and strips invisible/bidi characters", async () => {
      const g = await adult();
      await post(g.gameId, valid({ questionId: TEXT_Q.id, version: TEXT_Q.version, answer: "a\nb\tc  d\u200bE\u202eF\ufeffG" }), g.secret);
      expect((await repo.listAnswers(g.gameId))[0].answer).toBe("a b c dEFG");
    });
    it("rejects bad input with 400 and writes nothing", async () => {
      const g = await adult();
      const bad: unknown[] = [
        valid({ questionId: "nope" }),
        valid({ version: 999 }),
        valid({ answer: "not-an-option" }),
        valid({ answer: 5 }),
        valid({ answer: { a: 1 } }),
        valid({ answer: null }),
        valid({ answer: undefined }),
        valid({ shownAt: "now" }),
        valid({ shownAt: null }),
        valid({ shownAt: undefined }),
        valid({ shownAt: 1.5 }),
        valid({ shownAt: 1e300 }),
        valid({ shownAt: -1 }),
        valid({ shownAt: "123" }),
        { ...valid(), shownAt: NaN },
        valid({ sceneIndex: 99 }),
        valid({ sceneIndex: -1 }),
        valid({ sceneIndex: 1.5 }),
        valid({ sceneIndex: "0" }),
        valid({ questionId: TEXT_Q.id, version: TEXT_Q.version, answer: ["x"] }),
        valid({ questionId: TEXT_Q.id, version: TEXT_Q.version, answer: "   " }),
        [1, 2],
      ];
      for (const b of bad) {
        const r = await post(g.gameId, b, g.secret);
        expect(r.status, JSON.stringify(b)).toBe(400);
      }
      expect(await repo.listAnswers(g.gameId)).toEqual([]);
    });
    it("a late answer with an older sceneIndex is stored against that index", async () => {
      const g = await adult();
      const state = built.games.get(g.gameId)!;
      built.games.set(g.gameId, { ...state, currentEventNumber: 3 });
      expect((await post(g.gameId, valid({ sceneIndex: 3 }), g.secret)).status).toBe(204);
      expect((await post(g.gameId, valid({ questionId: MOMENT_Q.id, version: MOMENT_Q.version, sceneIndex: 1, answer: "that they stay kind" }), g.secret)).status).toBe(204);
      const rows = await repo.listAnswers(g.gameId);
      expect(rows.map((r) => r.sceneIndex).sort()).toEqual([1, 3]);
      expect((await post(g.gameId, valid({ sceneIndex: 4 }), g.secret)).status).toBe(400);
    });
    it("rehydrates the game from the repo when it is not in memory", async () => {
      const g = await adult();
      built.games.delete(g.gameId);
      expect((await post(g.gameId, valid(), g.secret)).status).toBe(204);
    });
    it("double submit leaves one row, the later answer wins", async () => {
      const g = await adult();
      const opts = (TAP_Q.answer as { options: { value: string }[] }).options;
      await post(g.gameId, valid({ answer: opts[0].value }), g.secret);
      await post(g.gameId, valid({ answer: opts[1].value }), g.secret);
      const rows = await repo.listAnswers(g.gameId);
      expect(rows).toHaveLength(1);
      expect(rows[0].answer).toBe(opts[1].value);
    });
    it("a skip arriving after an answer does not overwrite it; answer after skip does", async () => {
      const g = await adult();
      await post(g.gameId, valid(), g.secret);
      expect((await post(g.gameId, { questionId: TAP_Q.id, version: TAP_Q.version, sceneIndex: 0, skipped: true, shownAt: 5 }, g.secret)).status).toBe(204);
      let [row] = await repo.listAnswers(g.gameId);
      expect(row.skipped).toBe(false);
      expect(row.answer).not.toBeNull();

      const g2 = await adult();
      await post(g2.gameId, { questionId: TAP_Q.id, version: TAP_Q.version, sceneIndex: 0, skipped: true, shownAt: 5 }, g2.secret);
      [row] = await repo.listAnswers(g2.gameId);
      expect(row).toMatchObject({ skipped: true, answer: null });
      await post(g2.gameId, valid(), g2.secret);
      [row] = await repo.listAnswers(g2.gameId);
      expect(row.skipped).toBe(false);
      expect(row.answer).not.toBeNull();
    });
  });

  describe("GameState in-memory fields", () => {
    it("parentContext and repairNote never appear in GET /state", async () => {
      const g = await adult();
      const s = built.games.get(g.gameId)!;
      built.games.set(g.gameId, { ...s, parentContext: "SECRET-CTX", repairNote: "SECRET-NOTE" });
      const text = await (await fetch(`${baseUrl}/game/${g.gameId}/state`)).text();
      expect(text).not.toContain("SECRET-CTX");
      expect(text).not.toContain("SECRET-NOTE");
      expect(text).not.toContain("parentContext");
      expect(text).not.toContain("repairNote");
    });
  });
});
