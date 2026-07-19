import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";
import { RestClient } from "./helpers/rest-client.js";
import type { GameEvent } from "../src/types.js";

/**
 * End-to-end playthrough over the REST API, exercising the whole solo arc:
 * create → generate event → family chat (streamed) → end chat (psychologist
 * identity update) → debrief → epilogue → adult chat → report card.
 *
 * The entire server stack is real (express routes, engines, state machine,
 * in-memory repository); only the LLM provider is served from a seed-keyed
 * cassette so the run is deterministic and offline in CI. Re-record with:
 *   LLM_CACHE_MODE=record npm test -w server
 */
describe("E2E: solo REST playthrough", () => {
  let server: TestServer;
  let api: RestClient;
  let gameId: string;

  beforeAll(async () => {
    server = await createTestServer("rest-playthrough");
    api = new RestClient(server.baseUrl);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("creates a game", async () => {
    const { status, json } = await api.post<{ gameId: string }>("/api/game", {
      childName: "Luna",
      relationshipType: "co-parents",
    });
    expect(status).toBe(200);
    expect(json.gameId).toBeTruthy();
    gameId = json.gameId;
  });

  it("generates the first event from the world manager", async () => {
    const { json } = await api.post<{ event: GameEvent; phase: string }>(
      `/api/game/${gameId}/next-event`
    );
    expect(json.phase).toBe("family_chat");
    expect(json.event).toMatchObject({
      eventNumber: 1,
      age: expect.any(Number),
      description: expect.any(String),
    });
    expect(json.event.description.length).toBeGreaterThan(0);
  });

  it("streams kid replies across a scripted family chat", async () => {
    const lines = [
      "Hi sweetheart, can you tell me what happened?",
      "It's okay, accidents happen. We're not mad.",
      "Let's clean it up together, alright?",
    ];
    let lastRemaining = Infinity;
    for (const [i, content] of lines.entries()) {
      const sender = i % 2 === 0 ? "parent1" : "parent2";
      const { chunks, kidResponse, messagesRemaining } = await api.sendMessage(
        gameId,
        sender,
        content
      );
      // The streamed chunks must reassemble into exactly the kid's reply.
      expect(chunks).toBe(kidResponse);
      expect(kidResponse.length).toBeGreaterThan(0);
      // The cap counts down as parents speak.
      expect(messagesRemaining).toBeLessThan(lastRemaining);
      lastRemaining = messagesRemaining;
    }
  });

  it("reflects the conversation in public game state", async () => {
    const { json } = await api.get<{
      messages: Array<{ sender: string }>;
      identityDocument?: string;
    }>(`/api/game/${gameId}/state`);
    // 3 parent + 3 kid messages, and the identity doc must stay private.
    expect(json.messages.length).toBe(6);
    expect(json.identityDocument).toBeUndefined();
  });

  it("ends the chat and runs the psychologist identity update", async () => {
    const { json } = await api.postSSE<{ phase: string }>(`/api/game/${gameId}/end-chat`);
    expect(json.phase).toBe("debrief");
    // A snapshot should now be persisted in the repository.
    const reloaded = await server.memRepo.loadGame(gameId);
    expect(reloaded?.identitySnapshots.length).toBe(1);
    expect(reloaded?.identityDocument.length).toBeGreaterThan(0);
  });

  it("ends the debrief, returning to event intro", async () => {
    const { json } = await api.post<{ phase: string }>(`/api/game/${gameId}/end-debrief`);
    expect(json.phase).toBe("event_intro");
  });

  it("generates the epilogue", async () => {
    const { json } = await api.postSSE<{ phase: string; epilogue: string }>(
      `/api/game/${gameId}/epilogue`
    );
    expect(json.phase).toBe("epilogue");
    expect(json.epilogue.length).toBeGreaterThan(0);
  });

  it("generates the final report card", async () => {
    const { json } = await api.postSSE<{ phase: string; reportCard: string }>(
      `/api/game/${gameId}/report-card`,
      { epilogue: "Luna grew up thoughtful and steady." }
    );
    expect(json.phase).toBe("report_card");
    expect(json.reportCard).toContain("Luna");
    // The endgame artifacts must be persisted.
    const endgame = await server.memRepo.getEndgame(gameId);
    expect(endgame?.reportCard.length).toBeGreaterThan(0);
  });

  // Adult conversations branch off the epilogue/event-intro phases (not the
  // report card), so they're exercised on their own game. startAdultConversation
  // builds the scenario event locally — no LLM call — so this stays offline.
  it("starts an adult conversation scenario from a fresh game", async () => {
    const created = await api.post<{ gameId: string }>("/api/game", { childName: "Luna" });
    const { json } = await api.post<{ phase: string; event: GameEvent }>(
      `/api/game/${created.json.gameId}/adult-chat`,
      { scenario: "Luna calls home, unsure whether to take a job across the country." }
    );
    expect(json.phase).toBe("adult_chat");
    expect(json.event.age).toBe(25);
    expect(json.event.description).toContain("job across the country");
  });
});
