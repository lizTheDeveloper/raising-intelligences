/**
 * Re-submitting the same personality must not rebuild the child.
 *
 * Production, 2026-08-06: game aefb-c75316f91516 posted /personality three
 * times and generated a personality_seed on each one —
 *   01:36:00  3854 tokens  $0.0177
 *   01:36:43  2850 tokens  $0.0133
 *   01:40:10  3755 tokens  $0.0173
 * $0.048 for one child instead of $0.016, and three ~50s calls held under the
 * per-game lock while the player waited.
 *
 * Cost is the least of it. `personalitySeed` is the child's temperament — the
 * thing every later scene is generated from. Regenerating it silently replaces
 * the child the player already met, and by 01:40 that game had been running for
 * four minutes. A duplicate POST (a refresh, a double-click, a retry after a
 * slow response) should return the child they have, not mint a new one.
 *
 * Editing answers is different and must still work: if the submitted
 * personality actually differs from what is stored, the seed is rebuilt.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { AddressInfo } from "net";

const seedMock = vi.fn(async () => "a quiet child who watches before speaking");
vi.mock("../src/game/personality.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generatePersonalitySeed: (...a: unknown[]) => seedMock(...(a as [])),
}));

const { buildServer } = await import("../src/app.js");
const { MockLLMClient } = await import("../src/llm/mock.js");
const { InMemoryGameRepository } = await import("../src/db/repository.js");

const OCEAN = [3, 2, 4, 3, 2];
const BODY = { ocean: OCEAN, confessional1: "I worry.", confessional2: "I hope.", slot: "parent1" };

let built: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function newSoloGame(): Promise<string> {
  const res = await post("/game", { childName: "Kai", relationshipType: "solo parent" });
  return ((await res.json()) as { gameId: string }).gameId;
}

describe("the child's personality is built once", () => {
  beforeAll(async () => {
    const mock = new MockLLMClient();
    // One per game created below, plus slack: creating a game kicks off a
    // background prefetch that consumes an event, and a short list makes that
    // prefetch reject with "No mock events available" as an unhandled error.
    mock.events = Array.from({ length: 12 }, (_, i) => ({
      eventNumber: i + 1,
      age: 4,
      description: "Your child is 4. They broke a vase.",
      setting: "Living room",
      trigger: "Accident",
    }));
    built = buildServer({
      llm: mock,
      repo: new InMemoryGameRepository(),
      enableEviction: false,
      allowedOrigin: "*",
    });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => built.httpServer.close(() => r()));
  });

  beforeEach(() => {
    seedMock.mockClear();
    seedMock.mockResolvedValue("a quiet child who watches before speaking");
  });

  it("does not rebuild the child on an identical re-submission", async () => {
    const id = await newSoloGame();

    await post(`/game/${id}/personality`, BODY);
    expect(seedMock, "first submission must build the child").toHaveBeenCalledTimes(1);

    await post(`/game/${id}/personality`, BODY);

    expect(
      seedMock,
      "a duplicate POST replaced the child the player had already met, and billed for it",
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps the original seed text after a duplicate", async () => {
    const id = await newSoloGame();
    await post(`/game/${id}/personality`, BODY);

    seedMock.mockResolvedValue("a COMPLETELY different child");
    await post(`/game/${id}/personality`, BODY);

    const state = (await (await fetch(`${baseUrl}/game/${id}/state`)).json()) as {
      personalitySeed?: string;
    };
    // /state may not expose the seed; the call-count assertion above is the
    // load-bearing one. When it is exposed, it must be the original child.
    if (state.personalitySeed !== undefined) {
      expect(state.personalitySeed).not.toContain("COMPLETELY different");
    }
    expect(seedMock).toHaveBeenCalledTimes(1);
  });

  it("still rebuilds when the player actually changes their answers", async () => {
    // Guard against fixing this by never regenerating.
    const id = await newSoloGame();
    await post(`/game/${id}/personality`, BODY);

    await post(`/game/${id}/personality`, { ...BODY, ocean: [1, 1, 1, 1, 1] });

    expect(
      seedMock,
      "an edited personality was ignored — the player's changes did nothing",
    ).toHaveBeenCalledTimes(2);
  });

  it("still builds the child on the very first submission", async () => {
    const id = await newSoloGame();
    const res = await post(`/game/${id}/personality`, BODY);

    expect(await res.json()).toMatchObject({ ready: true });
    expect(seedMock).toHaveBeenCalledTimes(1);
  });
});
