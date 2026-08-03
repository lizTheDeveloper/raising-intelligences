import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";

/**
 * Regression test for #139: the unauthenticated GET /game/:id/state endpoint
 * must NOT echo back `parentPersonalities`, which holds both parents' raw OCEAN
 * scores and their intimate free-text confessionals. Leaking it exposed one
 * parent's confessionals to the other (and to anyone holding the gameId). The
 * confessionals are server-only — they seed the child and drive context
 * assembly; the client never reads them from this response.
 */
describe("GET /game/:id/state privacy (#139)", () => {
  let built: BuiltServer;
  let baseUrl: string;

  beforeAll(async () => {
    const mock = new MockLLMClient();
    // Creating a game kicks off a prefetch of the next event via the LLM; give
    // the mock one so that background call resolves instead of rejecting.
    mock.events = [
      {
        eventNumber: 1,
        age: 4,
        description: "Your child is 4. They broke a vase.",
        setting: "Living room",
        trigger: "Accident",
      },
    ];
    const repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) =>
      built.httpServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = built.httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => built.httpServer.close(() => resolve()));
  });

  it("does not expose parentPersonalities or confessional text", async () => {
    const SECRET_CONFESSION = "SENTINEL-CONFESSION-do-not-leak-9f3a";

    const createRes = await fetch(`${baseUrl}/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
      body: JSON.stringify({ childName: "Kai" }),
    });
    const { gameId } = (await createRes.json()) as { gameId: string };

    const personalityRes = await fetch(`${baseUrl}/game/${gameId}/personality`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
      body: JSON.stringify({
        ocean: [3, 3, 3, 3, 3],
        confessional1: SECRET_CONFESSION,
        confessional2: "another private thing",
        slot: "parent1",
      }),
    });
    expect(personalityRes.status).toBe(200);

    const stateRes = await fetch(`${baseUrl}/game/${gameId}/state`);
    expect(stateRes.status).toBe(200);
    const raw = await stateRes.text();

    // The confessional text must not appear anywhere in the serialized state.
    expect(raw).not.toContain(SECRET_CONFESSION);

    const state = JSON.parse(raw) as Record<string, unknown>;
    expect(state.parentPersonalities).toBeUndefined();
  });
});
