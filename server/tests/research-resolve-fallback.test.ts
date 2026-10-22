import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";

describe("a failed research lookup does not break gameplay routes", () => {
  let built: BuiltServer;
  let base: string;
  let repo: InMemoryGameRepository;
  const saved = process.env.RI_RESEARCH_ENABLED;
  beforeAll(async () => {
    process.env.RI_RESEARCH_ENABLED = "true";
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: new MockLLMClient(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    await built.close();
    if (saved === undefined) delete process.env.RI_RESEARCH_ENABLED; else process.env.RI_RESEARCH_ENABLED = saved;
  });

  it("rehydrates the game without a context and does not 500", async () => {
    const r = await fetch(`${base}/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.9" },
      body: JSON.stringify({ childName: "Kai", birthYear: 1985 }),
    });
    const { gameId } = (await r.json()) as { gameId: string };
    built.games.delete(gameId); // as if evicted
    const spy = vi.spyOn(repo, "listAnswers").mockRejectedValue(new Error("db down"));
    const res = await fetch(`${base}/game/${gameId}/state`);
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(built.games.get(gameId)?.parentContext).toBeUndefined();
  });
});
