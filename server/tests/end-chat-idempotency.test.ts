import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";
import { RestClient } from "./helpers/rest-client.js";
import { createGame } from "../src/game/state-machine.js";

/**
 * Regression for the top production error on Raising Intelligences:
 *   "Invalid transition: END_FAMILY_CHAT from phase debrief"
 *
 * end-chat runs a slow multi-LLM step inside a per-game lock. A double-click,
 * a retry, or a dropped-then-reconnected SSE re-issues POST /end-chat after the
 * first call already advanced the game past family_chat. The endpoint was not
 * idempotent, so the retry threw and surfaced an error to a user whose game had
 * actually progressed fine — often looping several times per minute.
 *
 * A stale/duplicate end-chat must be a safe no-op that reports the current phase.
 * In replay mode the LLM throws if called, so a passing test also proves the
 * guard short-circuits before any psychologist/grooming work.
 */
describe("end-chat idempotency", () => {
  let server: TestServer;
  let api: RestClient;

  beforeAll(async () => {
    server = await createTestServer("end-chat-idempotency");
    api = new RestClient(server.baseUrl);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("returns the current phase (not an error) when the game already left family_chat", async () => {
    const state = { ...createGame("Luna"), phase: "debrief" as const };
    await server.memRepo.saveGame(state);

    const { json } = await api.postSSE<{ phase: string }>(`/api/game/${state.id}/end-chat`);
    expect(json.phase).toBe("debrief");
  });
});
