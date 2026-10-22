import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { classifyBirthYear } from "../src/research/age.js";
import { isResearchEnabled } from "../src/research/config.js";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("classifyBirthYear", () => {
  it.each([
    [2000, true],
    [2007, true],
    [2008, false],
    [2026, false],
    [1900, true],
  ])("year %i -> isAdult %s", (year, isAdult) => {
    expect(classifyBirthYear(year, NOW)).toEqual({ ok: true, birthYear: year, isAdult });
  });

  it("uses a conservative 19-year cutoff on calendar years", () => {
    expect(classifyBirthYear(2007, new Date("2025-06-15T12:00:00Z"))).toMatchObject({ isAdult: false });
    expect(classifyBirthYear(2007, new Date("2026-06-15T12:00:00Z"))).toMatchObject({ isAdult: true });
  });

  it.each([1899, "abc", "2000", 1.5, null, undefined, 2027, NaN, Infinity, {}])(
    "rejects %s",
    (input) => {
      const r = classifyBirthYear(input, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.error).toBe("string");
    },
  );
});

describe("isResearchEnabled", () => {
  const original = process.env.RI_RESEARCH_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.RI_RESEARCH_ENABLED;
    else process.env.RI_RESEARCH_ENABLED = original;
  });

  it("is true only for the exact string 'true'", () => {
    delete process.env.RI_RESEARCH_ENABLED;
    expect(isResearchEnabled()).toBe(false);
    for (const v of ["1", "TRUE", "yes", ""]) {
      process.env.RI_RESEARCH_ENABLED = v;
      expect(isResearchEnabled()).toBe(false);
    }
    process.env.RI_RESEARCH_ENABLED = "true";
    expect(isResearchEnabled()).toBe(true);
  });
});

describe("POST /api/game birthYear", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let repo: InMemoryGameRepository;
  let n = 0;

  beforeAll(async () => {
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: new MockLLMClient(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await built.close();
  });

  async function create(body: Record<string, unknown>) {
    n++;
    const res = await fetch(`${baseUrl}/api/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.77.0.${n}` },
      body: JSON.stringify({ childName: "Wren", ...body }),
    });
    return { status: res.status, json: (await res.json()) as { gameId?: string; error?: string } };
  }

  it("missing birthYear stores nothing and still works", async () => {
    const { status, json } = await create({});
    expect(status).toBe(200);
    expect(Object.keys(json)).toEqual(["gameId"]);
    expect(await repo.getIsAdult(json.gameId!)).toBeNull();
  });

  it("adult birth year is stored with isAdult true", async () => {
    const spy = await spyRecordAge();
    const { json } = await create({ birthYear: 2000 });
    expect(await repo.getIsAdult(json.gameId!)).toBe(true);
    expect(spy.calls).toEqual([{ gameId: json.gameId, age: { birthYear: 2000, isAdult: true } }]);
    spy.restore();
  });

  it("under-18 stores isAdult false and never the birth year", async () => {
    const spy = await spyRecordAge();
    const year = new Date().getFullYear() - 10;
    const { json } = await create({ birthYear: year });
    expect(await repo.getIsAdult(json.gameId!)).toBe(false);
    expect(spy.calls).toEqual([{ gameId: json.gameId, age: { birthYear: null, isAdult: false } }]);
    spy.restore();
  });

  it("rejects a numeric string", async () => {
    const { status } = await create({ birthYear: "2000" });
    expect(status).toBe(400);
  });

  it("rejects an out-of-range year", async () => {
    const { status } = await create({ birthYear: 1850 });
    expect(status).toBe(400);
  });

  async function spyRecordAge() {
    const calls: Array<{ gameId: string; age: { birthYear: number | null; isAdult: boolean } }> = [];
    const orig = repo.recordAge.bind(repo);
    repo.recordAge = async (gameId, age) => {
      calls.push({ gameId, age });
      return orig(gameId, age);
    };
    return { calls, restore: () => { repo.recordAge = orig; } };
  }
});
