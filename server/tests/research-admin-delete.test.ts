import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";

const TOKEN = "admin-token-for-delete-test";

describe("DELETE /api/admin/games/:id", () => {
  let built: BuiltServer;
  let base: string;
  let repo: InMemoryGameRepository;
  const saved = process.env.ADMIN_TOKEN;
  let ip = 0;

  beforeAll(async () => {
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: new MockLLMClient(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => { await built.close(); });
  beforeEach(() => { process.env.ADMIN_TOKEN = TOKEN; });
  afterEach(() => { if (saved === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved; });

  async function makeGame() {
    const r = await fetch(`${base}/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${++ip}` },
      body: JSON.stringify({ childName: "Kai" }),
    });
    const g = (await r.json()) as { gameId: string; secret: string };
    await repo.saveAnswer({ gameId: g.gameId, sceneIndex: 1, questionId: "q", questionVersion: 1, kind: "about_you", answer: "x", skipped: false, shownAt: 1, answeredAt: 2 });
    return g;
  }
  const del = (id: string, auth?: string) =>
    fetch(`${base}/admin/games/${id}`, { method: "DELETE", headers: auth ? { Authorization: auth } : {} });

  it("rejects a missing or wrong token and leaves the data intact", async () => {
    const g = await makeGame();
    expect((await del(g.gameId)).status).toBe(401);
    expect((await del(g.gameId, "Bearer nope")).status).toBe(401);
    expect(await repo.loadGame(g.gameId)).not.toBeNull();
    expect(built.games.has(g.gameId)).toBe(true);
    expect(await repo.listAnswers(g.gameId)).toHaveLength(1);
  });

  it("fails closed when ADMIN_TOKEN is unset", async () => {
    const g = await makeGame();
    delete process.env.ADMIN_TOKEN;
    expect((await del(g.gameId, "Bearer undefined")).status).toBe(503);
    expect((await del(g.gameId, "Bearer ")).status).toBe(503);
    expect(await repo.loadGame(g.gameId)).not.toBeNull();
  });

  it("the right token erases the stored data and the in-memory copy", async () => {
    const g = await makeGame();
    expect((await del(g.gameId, `Bearer ${TOKEN}`)).status).toBe(204);
    expect(await repo.loadGame(g.gameId)).toBeNull();
    expect(await repo.listAnswers(g.gameId)).toEqual([]);
    expect(built.games.has(g.gameId)).toBe(false);
    expect((await fetch(`${base}/game/${g.gameId}/state`)).status).toBe(404);
    expect((await del(g.gameId, `Bearer ${TOKEN}`)).status).toBe(404);
  });

  it("deletes a legacy game that has no secret", async () => {
    const legacy = createGame("Old");
    await repo.saveGame(legacy);
    expect(await repo.getAccessSecretHash(legacy.id)).toBeNull();
    expect((await del(legacy.id, `Bearer ${TOKEN}`)).status).toBe(204);
    expect(await repo.loadGame(legacy.id)).toBeNull();
  });

  it("answers 404 for an unknown game", async () => {
    expect((await del("00000000-0000-4000-8000-000000000000", `Bearer ${TOKEN}`)).status).toBe(404);
  });
});
