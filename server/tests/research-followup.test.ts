import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository, PgGameRepository } from "../src/db/repository.js";
import { normalizeEmail } from "../src/research/email.js";
import { logger } from "../src/logger.js";

const EMAIL = "Parent.Name+ri@Example.COM";
const STORED = "Parent.Name+ri@example.com";

describe("normalizeEmail", () => {
  it("trims and lowercases only the domain", () => {
    expect(normalizeEmail(`  ${EMAIL}  `)).toBe(STORED);
  });
  it("rejects malformed input", () => {
    const bad: unknown[] = [
      "", "   ", "nope", "a@b", "a@@b.com", "a@b@c.com", "a b@c.com", "a@b .com", "a\u0000@b.com",
      "a\t@b.com", "@b.com", "a@.com", "a@b..com", "a@b.com.", "a@-b.com", "a,b@c.com", "a@b.c om",
      `${"a".repeat(250)}@b.com`, 42, null, undefined, {}, ["a@b.com"], true,
    ];
    for (const b of bad) expect(normalizeEmail(b), String(b)).toBeNull();
  });
  it("accepts a 254 character address and rejects 255", () => {
    const labels = `${"x".repeat(60)}.${"y".repeat(60)}.${"z".repeat(60)}`;
    const at254 = `${"a".repeat(64)}@${labels}.abcdef`;
    expect(at254.length).toBe(254);
    expect(normalizeEmail(at254)).toBe(at254);
    expect(normalizeEmail(`${"a".repeat(64)}@${labels}.abcdefg`)).toBeNull();
  });
});

describe("InMemory follow-up contact", () => {
  const c = (email: string) => ({ email, consentFollowup: true as const, consentAiAnalysis: true as const });
  async function repoWithGame() {
    const repo = new InMemoryGameRepository();
    const mkState = (id: string) => ({ id, sidebarUsed: {}, therapyMessages: [] }) as never;
    await repo.saveGame(mkState("g1"));
    return repo;
  }
  it("saves, replaces, withdraws, re-consents and deletes with the game", async () => {
    const repo = await repoWithGame();
    expect(await repo.getFollowupContact("g1")).toBeNull();
    await repo.withdrawFollowup("g1"); // nothing stored: no-op
    expect(await repo.getFollowupContact("g1")).toBeNull();

    await repo.saveFollowupContact("g1", c("a@b.com"));
    const first = (await repo.getFollowupContact("g1"))!;
    expect(first).toMatchObject({ email: "a@b.com", consentFollowup: true, consentAiAnalysis: true, withdrawnAt: null });
    expect(first.consentedAt).toBeGreaterThan(0);

    await repo.saveFollowupContact("g1", c("z@y.com"));
    expect((await repo.getFollowupContact("g1"))!.email).toBe("z@y.com");

    await repo.withdrawFollowup("g1");
    await repo.withdrawFollowup("g1");
    const w = (await repo.getFollowupContact("g1"))!;
    expect(w).toMatchObject({ email: null, consentFollowup: false, consentAiAnalysis: false });
    expect(w.withdrawnAt).toBeGreaterThan(0);

    await repo.saveFollowupContact("g1", c("again@b.com"));
    expect(await repo.getFollowupContact("g1")).toMatchObject({ email: "again@b.com", consentFollowup: true, withdrawnAt: null });

    await repo.deleteGameData("g1");
    expect(await repo.getFollowupContact("g1")).toBeNull();
    expect(repo.followupRowCounts()).toEqual({ links: 0, contacts: 0 });
  });
  it("uses a random pseudonym unrelated to the game id", async () => {
    const repo = await repoWithGame();
    await repo.saveFollowupContact("g1", c("a@b.com"));
    const p = repo.followupPseudonymFor("g1")!;
    expect(p).toMatch(/^[0-9a-f-]{36}$/);
    expect(p).not.toContain("g1");
    await repo.withdrawFollowup("g1");
    await repo.saveFollowupContact("g1", c("a@b.com"));
    expect(repo.followupPseudonymFor("g1")).toBe(p); // stable across consent cycles
  });
  it("refuses a game that does not exist", async () => {
    const repo = new InMemoryGameRepository();
    await expect(repo.saveFollowupContact("nope", c("a@b.com"))).rejects.toThrow();
  });
});

describe("PgGameRepository follow-up (mock db)", () => {
  function mk(handler: (sql: string) => { rows: unknown[] } = () => ({ rows: [] })) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (s: string, p?: unknown[]) => { calls.push({ sql: s.replace(/\s+/g, " ").trim(), params: p ?? [] }); return handler(s); },
      release: () => {},
    };
    const repo = new PgGameRepository({
      query: async (s: string, p?: unknown[]) => { calls.push({ sql: s.replace(/\s+/g, " ").trim(), params: p ?? [] }); return handler(s); },
      connect: async () => client,
    } as never);
    return { repo, calls };
  }
  it("saveFollowupContact links with a random pseudonym, then upserts the contact", async () => {
    const { repo, calls } = mk((s) => (s.includes("SELECT pseudonym_id") ? { rows: [{ pseudonym_id: "p-1" }] } : { rows: [] }));
    await repo.saveFollowupContact("game-1", { email: "a@b.com", consentFollowup: true, consentAiAnalysis: true });
    const link = calls.find((c) => c.sql.startsWith("INSERT INTO followup_links"))!;
    expect(link.sql).toContain("ON CONFLICT (game_id) DO NOTHING");
    expect(link.params[0]).toBe("game-1");
    expect(String(link.params[1])).toMatch(/^[0-9a-f-]{36}$/);
    expect(link.params[1]).not.toBe("game-1");
    const contact = calls.find((c) => c.sql.startsWith("INSERT INTO followup_contacts"))!;
    expect(contact.sql).toContain("ON CONFLICT (pseudonym_id) DO UPDATE");
    expect(contact.sql).toContain("withdrawn_at");
    expect(contact.params[0]).toBe("p-1");
    expect(contact.params).toContain("a@b.com");
    // email is never written into a table that has a game_id
    expect(calls.filter((c) => c.params.includes("a@b.com")).every((c) => c.sql.includes("followup_contacts"))).toBe(true);
  });
  it("withdrawFollowup nulls the email and both consents and sets withdrawn_at", async () => {
    const { repo, calls } = mk();
    await repo.withdrawFollowup("game-1");
    const u = calls.find((c) => c.sql.startsWith("UPDATE followup_contacts"))!;
    expect(u.sql).toContain("email = NULL");
    expect(u.sql).toContain("consent_followup = false");
    expect(u.sql).toContain("consent_ai_analysis = false");
    expect(u.sql).toContain("withdrawn_at");
    expect(u.sql).toContain("followup_links");
    expect(u.params[0]).toBe("game-1");
  });
  it("deleteGameData looks up the pseudonym and removes the contact and link before the game, in the transaction", async () => {
    const { repo, calls } = mk((s) => (s.includes("SELECT pseudonym_id") ? { rows: [{ pseudonym_id: "p-9" }] } : { rows: [] }));
    await repo.deleteGameData("game-1");
    const sqls = calls.map((c) => c.sql);
    const iSel = sqls.findIndex((s) => s.startsWith("SELECT pseudonym_id FROM followup_links"));
    const iC = sqls.findIndex((s) => s.startsWith("DELETE FROM followup_contacts"));
    const iL = sqls.findIndex((s) => s.startsWith("DELETE FROM followup_links"));
    const iG = sqls.findIndex((s) => s.startsWith("DELETE FROM games"));
    const iB = sqls.indexOf("BEGIN");
    expect(iB).toBeGreaterThanOrEqual(0);
    expect(iSel).toBeGreaterThan(iB);
    expect(iC).toBeGreaterThan(iSel);
    expect(iL).toBeGreaterThan(iC);
    expect(iG).toBeGreaterThan(iL);
    expect(calls[iC].params).toEqual(["p-9"]);
  });
});

describe("follow-up routes", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let repo: InMemoryGameRepository;
  const saved = process.env.RI_RESEARCH_ENABLED;
  const logged: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeAll(async () => {
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: new MockLLMClient(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => built.httpServer.close(() => r()));
  });
  beforeEach(() => {
    process.env.RI_RESEARCH_ENABLED = "true";
    for (const level of ["debug", "info", "warn", "error"] as const) {
      spies.push(vi.spyOn(logger, level).mockImplementation((...a: unknown[]) => { logged.push(JSON.stringify(a)); }));
    }
  });
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    if (saved === undefined) delete process.env.RI_RESEARCH_ENABLED; else process.env.RI_RESEARCH_ENABLED = saved;
  });

  let ipCounter = 0;
  const fresh = () => `198.51.100.${(++ipCounter % 250) + 1}`;
  async function makeGame(birthYear?: number): Promise<{ gameId: string; secret: string }> {
    const res = await fetch(`${baseUrl}/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `192.0.2.${(++ipCounter % 250) + 1}` },
      body: JSON.stringify({ childName: "Kai", ...(birthYear !== undefined ? { birthYear } : {}) }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { gameId: string; secret: string };
  }
  const adult = () => makeGame(1985);
  const minorYear = new Date().getFullYear() - 10;
  const body = (over: Record<string, unknown> = {}) => ({ email: EMAIL, consentFollowup: true, consentAiAnalysis: true, ...over });
  const post = (id: string, b: unknown, secret?: string) =>
    fetch(`${baseUrl}/research/followup/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": fresh(), ...(secret ? { "x-game-secret": secret } : {}) },
      body: typeof b === "string" ? b : JSON.stringify(b),
    });
  const del = (id: string, secret?: string) =>
    fetch(`${baseUrl}/research/followup/${id}`, {
      method: "DELETE",
      headers: { "X-Forwarded-For": fresh(), ...(secret ? { "x-game-secret": secret } : {}) },
    });

  describe("consent and email validation", () => {
    it("each consent missing, false, 'true' or 1 is a 400 and nothing is stored", async () => {
      const g = await adult();
      for (const field of ["consentFollowup", "consentAiAnalysis"]) {
        const variants: unknown[] = [false, "true", 1, null, "yes", [true], {}];
        for (const v of variants) {
          const res = await post(g.gameId, body({ [field]: v }), g.secret);
          expect(res.status, `${field}=${JSON.stringify(v)}`).toBe(400);
        }
        const missing = body();
        delete (missing as Record<string, unknown>)[field];
        expect((await post(g.gameId, missing, g.secret)).status).toBe(400);
      }
      expect((await post(g.gameId, "not json", g.secret)).status).toBeGreaterThanOrEqual(400);
      expect((await post(g.gameId, [], g.secret)).status).toBe(400);
      expect(await repo.getFollowupContact(g.gameId)).toBeNull();
    });
    it("invalid emails are 400 and nothing is stored", async () => {
      const g = await adult();
      const bad: unknown[] = ["", "no-at.example.com", "a@@b.com", "a@b@c.com", "a b@c.com", "a@b.com\u0007", "a@b.c\u0000om", "a@b", `${"a".repeat(260)}@b.com`, 7, null];
      for (const email of bad) {
        expect((await post(g.gameId, body({ email }), g.secret)).status, String(email).slice(0, 20)).toBe(400);
      }
      const noEmail = body();
      delete (noEmail as Record<string, unknown>).email;
      expect((await post(g.gameId, noEmail, g.secret)).status).toBe(400);
      expect(await repo.getFollowupContact(g.gameId)).toBeNull();
    });
  });

  describe("storing", () => {
    it("both consents true + valid email stores it, normalized, with a consent timestamp; the response is empty", async () => {
      const g = await adult();
      const before = Date.now();
      const res = await post(g.gameId, body({ email: `  ${EMAIL} ` }), g.secret);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      const c = (await repo.getFollowupContact(g.gameId))!;
      expect(c.email).toBe(STORED);
      expect(c.consentFollowup).toBe(true);
      expect(c.consentAiAnalysis).toBe(true);
      expect(c.consentedAt).toBeGreaterThanOrEqual(before);
      expect(c.withdrawnAt).toBeNull();
    });
    it("posting twice replaces the email (last wins) and refreshes consented_at", async () => {
      const g = await adult();
      await post(g.gameId, body({ email: "one@example.com" }), g.secret);
      const first = (await repo.getFollowupContact(g.gameId))!;
      await new Promise((r) => setTimeout(r, 5));
      await post(g.gameId, body({ email: "two@example.com" }), g.secret);
      const second = (await repo.getFollowupContact(g.gameId))!;
      expect(second.email).toBe("two@example.com");
      expect(second.consentedAt).toBeGreaterThan(first.consentedAt!);
    });
    it("withdraw clears the email, sets withdrawn_at, drops both consents, and is idempotent", async () => {
      const g = await adult();
      // nothing stored yet: still 204
      expect((await del(g.gameId, g.secret)).status).toBe(204);
      expect(await repo.getFollowupContact(g.gameId)).toBeNull();
      await post(g.gameId, body(), g.secret);
      const r1 = await del(g.gameId, g.secret);
      expect(r1.status).toBe(204);
      expect(await r1.text()).toBe("");
      expect((await del(g.gameId, g.secret)).status).toBe(204);
      const c = (await repo.getFollowupContact(g.gameId))!;
      expect(c.email).toBeNull();
      expect(c.consentFollowup).toBe(false);
      expect(c.consentAiAnalysis).toBe(false);
      expect(c.withdrawnAt).toBeGreaterThan(0);
    });
    it("consent can be given again after withdrawal", async () => {
      const g = await adult();
      await post(g.gameId, body({ email: "one@example.com" }), g.secret);
      await del(g.gameId, g.secret);
      expect((await post(g.gameId, body({ email: "three@example.com" }), g.secret)).status).toBe(204);
      const c = (await repo.getFollowupContact(g.gameId))!;
      expect(c).toMatchObject({ email: "three@example.com", consentFollowup: true, consentAiAnalysis: true, withdrawnAt: null });
    });
  });

  describe("forged requests fail and write nothing", () => {
    it("no secret / wrong secret / malformed id are 403 for both verbs", async () => {
      const g = await adult();
      for (const s of [undefined, "0".repeat(64)]) {
        expect((await post(g.gameId, body(), s)).status).toBe(403);
        expect((await del(g.gameId, s)).status).toBe(403);
      }
      expect((await post("not-a-uuid", body(), "x")).status).toBe(403);
      expect(await repo.getFollowupContact(g.gameId)).toBeNull();
    });
    it("a withdraw with no secret does not clear a stored email", async () => {
      const g = await adult();
      await post(g.gameId, body(), g.secret);
      expect((await del(g.gameId)).status).toBe(403);
      expect((await repo.getFollowupContact(g.gameId))!.email).toBe(STORED);
    });
    it("under-18, legacy, flag-off and seated games are 404 for both verbs", async () => {
      const minor = await makeGame(minorYear);
      const legacy = await makeGame();
      const flagOff = await adult();
      const seated = await adult();
      built.sessions.set(seated.gameId, { gameId: seated.gameId, players: [{} as never] });
      const cases: Array<[string, { gameId: string; secret: string }]> = [
        ["under-18", minor], ["legacy", legacy], ["seated", seated],
      ];
      for (const [name, g] of cases) {
        const p = await post(g.gameId, body(), g.secret);
        expect(p.status, name).toBe(404);
        expect(await p.json()).toEqual({ error: "Not available" });
        expect((await del(g.gameId, g.secret)).status, name).toBe(404);
        expect(await repo.getFollowupContact(g.gameId), name).toBeNull();
      }
      process.env.RI_RESEARCH_ENABLED = "false";
      expect((await post(flagOff.gameId, body(), flagOff.secret)).status).toBe(404);
      expect((await del(flagOff.gameId, flagOff.secret)).status).toBe(404);
      expect(await repo.getFollowupContact(flagOff.gameId)).toBeNull();
      // 403 outranks everything when the secret is wrong
      expect((await post(flagOff.gameId, body())).status).toBe(403);
    });
    it("a game that becomes seated can no longer be written to", async () => {
      const g = await adult();
      built.sessions.set(g.gameId, { gameId: g.gameId, players: [{} as never] });
      expect((await post(g.gameId, body(), g.secret)).status).toBe(404);
      built.sessions.delete(g.gameId);
    });
  });

  describe("rate limit", () => {
    it("POST is limited per client", async () => {
      const g = await adult();
      const ip = "203.0.113.200";
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await fetch(`${baseUrl}/research/followup/${g.gameId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, "x-game-secret": g.secret },
          body: JSON.stringify(body()),
        });
        statuses.push(r.status);
      }
      expect(statuses).toContain(429);
    });
  });

  describe("deletion", () => {
    it("deleteGameData removes the link and the contact row reached through the pseudonym", async () => {
      const g = await adult();
      await post(g.gameId, body(), g.secret);
      expect(repo.followupRowCounts().contacts).toBeGreaterThanOrEqual(1);
      const pseudonym = repo.followupPseudonymFor(g.gameId)!;
      await repo.deleteGameData(g.gameId);
      expect(repo.followupPseudonymFor(g.gameId)).toBeNull();
      expect(repo.followupHasContactRow(pseudonym)).toBe(false);
      expect(await repo.getFollowupContact(g.gameId)).toBeNull();
    });
  });

  describe("the email never leaks", () => {
    it("is absent from listAnswers, answers routes, GET /state, follow-up responses and logs", async () => {
      const g = await adult();
      const needle = "leaky.person@example.com";
      const out: string[] = [];
      const p = await post(g.gameId, body({ email: needle }), g.secret);
      out.push(await p.text());
      // answers: save one, fetch the question list, read state
      const q = await fetch(`${baseUrl}/game/${g.gameId}/questions?wait=first`, { headers: { "x-game-secret": g.secret } });
      const qs = (await q.json()) as { questions: Array<{ id: string; version: number; answer: { type: string; options?: Array<{ value: string }> } }> };
      out.push(JSON.stringify(qs));
      const first = qs.questions[0];
      const ans = await fetch(`${baseUrl}/game/${g.gameId}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": fresh(), "x-game-secret": g.secret },
        body: JSON.stringify({ questionId: first.id, version: first.version, sceneIndex: 0, answer: first.answer.type === "tap" ? first.answer.options![0].value : "hello", shownAt: 1 }),
      });
      out.push(await ans.text());
      out.push(JSON.stringify(await repo.listAnswers(g.gameId)));
      out.push(JSON.stringify(await repo.listMomentLabels(g.gameId)));
      const state = await fetch(`${baseUrl}/game/${g.gameId}/state`, { headers: { "x-game-secret": g.secret } });
      out.push(await state.text());
      out.push(JSON.stringify(await repo.loadGame(g.gameId)));
      // forged / rejected paths echo nothing either
      out.push(await (await post(g.gameId, body({ email: needle, consentAiAnalysis: false }), g.secret)).text());
      out.push(await (await post(g.gameId, body({ email: needle }))).text());
      out.push(await (await del(g.gameId, g.secret)).text());
      out.push(await (await post(g.gameId, `{"email":"${needle}"`, g.secret)).text());
      const all = out.join("\n").toLowerCase();
      expect(all).not.toContain("leaky.person");
      expect(logged.join("\n").toLowerCase()).not.toContain("leaky.person");
    });
  });
});
