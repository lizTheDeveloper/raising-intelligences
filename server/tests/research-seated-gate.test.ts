import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";

const EMAIL = "seat.test@example.org";

describe("solo-only research gates also check saved seats (no in-memory session)", () => {
  let built: BuiltServer;
  let base: string;
  let repo: InMemoryGameRepository;
  const saved = process.env.RI_RESEARCH_ENABLED;
  let ip = 0;

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    const mock = new MockLLMClient();
    mock.events = Array.from({ length: 20 }, (_, i) => ({ eventNumber: i + 1, age: 4, description: `S${i + 1}.`, setting: "Home", trigger: "T" }));
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*", socketPath: "/socket.io" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => { await built.close(); });
  beforeEach(() => { process.env.RI_RESEARCH_ENABLED = "true"; });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.RI_RESEARCH_ENABLED; else process.env.RI_RESEARCH_ENABLED = saved;
  });

  const call = (method: string, path: string, body?: unknown, secret?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${++ip % 250}`, ...(secret ? { "x-game-secret": secret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** An adult research game, played to the debrief of scene 1. */
  async function debriefGame() {
    const g = (await (await call("POST", "/game", { childName: "Kai", relationshipType: "solo parent", birthYear: 1985 })).json()) as { gameId: string; secret: string };
    await call("POST", `/game/${g.gameId}/personality`, { ocean: [3, 3, 3, 3, 3], confessional1: "x", slot: "parent1" });
    expect((await call("POST", `/game/${g.gameId}/next-event`, {})).status).toBe(200);
    await (await call("POST", `/game/${g.gameId}/end-chat`, {})).text();
    return g;
  }
  const followup = { email: EMAIL, consentFollowup: true, consentAiAnalysis: true };
  const answerBody = { questionId: "worry_for_child", version: 1, sceneIndex: 0, answer: "x", shownAt: Date.now() };

  async function statuses(g: { gameId: string; secret: string }) {
    return {
      questions: (await call("GET", `/game/${g.gameId}/questions?wait=first`, undefined, g.secret)).status,
      answers: (await call("POST", `/game/${g.gameId}/answers`, answerBody, g.secret)).status,
      followupPost: (await call("POST", `/research/followup/${g.gameId}`, followup, g.secret)).status,
      followupDelete: (await call("DELETE", `/research/followup/${g.gameId}`, undefined, g.secret)).status,
      repair: (await call("POST", `/game/${g.gameId}/repair`, { message: "I am sorry" }, g.secret)).status,
    };
  }

  it("a solo adult research game still works on every route", async () => {
    const g = await debriefGame();
    expect(await statuses(g)).toEqual({ questions: 200, answers: 204, followupPost: 204, followupDelete: 204, repair: 204 });
  });

  it("a game with saved seats and no session is refused everywhere", async () => {
    const g = await debriefGame();
    await repo.savePlayer(g.gameId, "parent1", "Ann", "tok");
    expect(built.games.has(g.gameId)).toBe(true);
    const s = await statuses(g);
    expect(s).toMatchObject({ questions: 404, answers: 404, followupPost: 404, followupDelete: 404 });
    expect(s.repair).toBe(409);
    expect(await repo.getFollowupContact(g.gameId)).toBeNull();
    expect((await repo.listAnswers(g.gameId)).filter((a) => a.kind === "repair")).toHaveLength(0);
  });

  it("a throwing loadPlayers fails closed", async () => {
    const g = await debriefGame();
    vi.spyOn(repo, "loadPlayers").mockRejectedValue(new Error("db down"));
    const s = await statuses(g);
    expect(s).toMatchObject({ questions: 404, answers: 404, followupPost: 404, followupDelete: 404 });
    expect(s.repair).toBe(409);
  });

  it("gate order is unchanged: no secret is a 403 before the seat check", async () => {
    const g = await debriefGame();
    await repo.savePlayer(g.gameId, "parent1", "Ann", "tok");
    expect((await call("GET", `/game/${g.gameId}/questions?wait=first`)).status).toBe(403);
    expect((await call("POST", `/research/followup/${g.gameId}`, followup)).status).toBe(403);
  });

  it("admin delete answers 404 for a malformed id instead of reaching the repository", async () => {
    process.env.ADMIN_TOKEN = "t";
    const spy = vi.spyOn(repo, "loadGame");
    const r = await fetch(`${base}/admin/games/not-a-uuid`, { method: "DELETE", headers: { Authorization: "Bearer t" } });
    delete process.env.ADMIN_TOKEN;
    expect(r.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});
