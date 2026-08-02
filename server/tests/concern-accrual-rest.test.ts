// Drives the real REST scene-end route (POST /game/:id/end-chat in
// routes/game.ts) end to end and asserts the concernLevel accumulator moves
// with the scene's safety tier. Mirrors the stable harness in
// dark-play-reroute-rest.test.ts (real express + routes + ConversationEngine;
// only the LLM is mocked). Kept out of the socket layer on purpose — that path
// is timing-fragile; this one is gated and reliable.
//
// These two tests prove the route WIRING for both tiers: "concern" raises the
// accumulator by CONCERN_INCREMENT; a clean "none" scene does not raise it
// (and, floored at 0, stays 0). Decay from a positive level is unit-covered in
// concern-accumulator.test.ts (the reducer applies the same signed delta this
// route feeds it), so we don't need fragile multi-scene navigation here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { CONCERN_INCREMENT } from "../src/game/state-machine.js";

const testEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

async function drainSSE(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("concern accumulator — accrual through the real REST scene-end route", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  let repo: InMemoryGameRepository;

  beforeAll(async () => {
    mock = new MockLLMClient();
    // Each game consumes a world_manager event on next-event AND another on the
    // end-chat prefetch; supply generously so neither test starves.
    mock.events = Array.from({ length: 12 }, (_, i) => ({ ...testEvent, eventNumber: i + 1 }));
    mock.kidResponses = Array.from({ length: 12 }, () => "ok");
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await built.close();
  });

  async function createGameAndReachFamilyChat(ip: string): Promise<string> {
    const createRes = await fetch(`${baseUrl}/api/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ childName: "Kai" }),
    });
    const { gameId } = (await createRes.json()) as { gameId: string };

    const nextRes = await fetch(`${baseUrl}/api/game/${gameId}/next-event`, {
      method: "POST",
      headers: { "X-Forwarded-For": ip },
    });
    const nextJson = (await nextRes.json()) as { phase: string };
    expect(nextJson.phase).toBe("family_chat");
    return gameId;
  }

  // A scene must contain at least one parent message, else classifyScene
  // short-circuits to tier "none" before consulting the (mocked) verdict.
  async function sendOneMessage(gameId: string, ip: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ sender: "parent1", content: "hello" }),
    });
    await drainSSE(res);
  }

  async function endChat(gameId: string, ip: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/end-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({}),
    });
    await drainSSE(res);
  }

  it("a scene-end 'concern' verdict raises concernLevel by CONCERN_INCREMENT", async () => {
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    const ip = "62.62.62.1";
    const gameId = await createGameAndReachFamilyChat(ip);
    await sendOneMessage(gameId, ip);
    await endChat(gameId, ip);

    const loaded = await repo.loadGame(gameId);
    expect(loaded?.concernLevel).toBe(CONCERN_INCREMENT);
  });

  it("GET /state never leaks concernLevel to clients (server-only, spec §5)", async () => {
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    const ip = "62.62.62.3";
    const gameId = await createGameAndReachFamilyChat(ip);
    await sendOneMessage(gameId, ip);
    await endChat(gameId, ip);
    // Sanity: it really did accrue server-side.
    expect((await repo.loadGame(gameId))?.concernLevel).toBe(CONCERN_INCREMENT);

    const stateRes = await fetch(`${baseUrl}/api/game/${gameId}/state`);
    const body = (await stateRes.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("concernLevel");
    expect(body).not.toHaveProperty("concerningStreak");
    expect(body).not.toHaveProperty("pendingGuidance");
    expect(body).not.toHaveProperty("identityDocument");
    // Dark Play Plan 3 — the ladder-gating internals are server-only for the
    // same reason concernLevel is: they must never leak the player's own
    // dark-parenting score back to them.
    expect(body).not.toHaveProperty("highestRungFired");
    expect(body).not.toHaveProperty("cpsOutcome");
  });

  it("GET /state never leaks parentPersonalities — OCEAN scores + confessionals are server-only (#139)", async () => {
    const ip = "62.62.62.4";
    const gameId = await createGameAndReachFamilyChat(ip);

    await fetch(`${baseUrl}/api/game/${gameId}/personality`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({
        ocean: [1, 2, 3, 4, 1],
        confessional1: "the most evil thing I did as a kid",
        confessional2: "one thing I never told my parents",
        slot: "parent1",
      }),
    });
    // Sanity: it really was persisted server-side.
    const loaded = await repo.loadGame(gameId);
    expect(loaded?.parentPersonalities?.parent1?.confessional1).toBe(
      "the most evil thing I did as a kid"
    );

    const stateRes = await fetch(`${baseUrl}/api/game/${gameId}/state`);
    const body = (await stateRes.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("parentPersonalities");
    expect(JSON.stringify(body)).not.toContain("the most evil thing I did as a kid");
  });

  it("a clean 'none' scene does not raise concernLevel (floored at 0)", async () => {
    mock.groomingResult = { tier: "none", reason: "" };
    const ip = "62.62.62.2";
    const gameId = await createGameAndReachFamilyChat(ip);
    await sendOneMessage(gameId, ip);
    await endChat(gameId, ip);

    const loaded = await repo.loadGame(gameId);
    expect(loaded?.concernLevel).toBe(0);
  });
});
