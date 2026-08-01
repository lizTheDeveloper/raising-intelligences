import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";
import { RestClient } from "./helpers/rest-client.js";
import { createGame } from "../src/game/state-machine.js";

/**
 * Regression for the RI production error (GlitchTip project 6):
 *   "Invalid transition: PARENT_MESSAGE from phase debrief"
 *
 * Sibling of the end-chat idempotency bug. A message sent just as the scene ends
 * (family_chat -> debrief), a double-send, or a stale client re-issues
 * POST /game/:id/message after the phase already advanced. handleParentMessage's
 * transition() then threw "Invalid transition PARENT_MESSAGE from phase <x>",
 * caught into "An internal error occurred" (a 500 to the user + a GlitchTip event).
 *
 * A message the game can no longer accept must be rejected CLEANLY, before any
 * moderation/LLM work — so it never reaches the error tracker and the user sees a
 * meaningful message instead of a generic failure. In replay mode the LLM throws
 * if called, so a passing test also proves the guard short-circuits early.
 */
describe("message out-of-phase guard", () => {
  let server: TestServer;
  let api: RestClient;

  beforeAll(async () => {
    server = await createTestServer("message-out-of-phase");
    api = new RestClient(server.baseUrl);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("rejects cleanly (not a 500) when the scene has already ended", async () => {
    const state = { ...createGame("Luna"), phase: "debrief" as const };
    await server.memRepo.saveGame(state);

    await expect(
      api.postSSE(`/api/game/${state.id}/message`, { sender: "parent1", content: "hi" })
    ).rejects.toThrow(/no longer accept/i);
  });
});
