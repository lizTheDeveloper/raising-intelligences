import { describe, it, expect } from "vitest";
import { EndgameEngine } from "../src/game/endgame-engine.js";
import { createGame, transition } from "../src/game/state-machine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

// A game that has finished its childhood events and is back in event_intro,
// ready for the endgame transitions.
function finishedGame() {
  let state = createGame("Luna");
  state = transition(state, { type: "START_EVENT", event: testEvent });
  state = transition(state, { type: "END_FAMILY_CHAT" });
  state = transition(state, {
    type: "IDENTITY_UPDATED",
    document: "Core beliefs: the world is safe.",
  });
  state = transition(state, { type: "END_DEBRIEF" });
  return state;
}

describe("EndgameEngine", () => {
  it("generateEpilogue transitions to epilogue phase and returns text", async () => {
    const mock = new MockLLMClient();
    // MockLLMClient.completeResponse draws from identityUpdates in order.
    mock.identityUpdates = ["They grew up to be thoughtful and brave."];
    const engine = new EndgameEngine(mock);

    const result = await engine.generateEpilogue(finishedGame());

    expect(result.state.phase).toBe("epilogue");
    expect(result.epilogue).toBe("They grew up to be thoughtful and brave.");
  });

  it("startAdultConversation transitions to adult_chat with a scenario event", async () => {
    const mock = new MockLLMClient();
    const engine = new EndgameEngine(mock);

    let state = await engine.generateEpilogue(finishedGame()).then((r) => r.state);
    state = await engine.startAdultConversation(
      state,
      "Luna calls you, unsure whether to take a job across the country."
    );

    expect(state.phase).toBe("adult_chat");
    expect(state.currentEvent?.description).toContain("job across the country");
    expect(state.parentMessageCount).toBe(0);
  });

  it("generateReportCard transitions to report_card phase and returns text", async () => {
    const mock = new MockLLMClient();
    // First completeResponse call -> epilogue, second -> report card.
    mock.identityUpdates = [
      "They grew up to be thoughtful.",
      "# Luna\n## Personality\nThoughtful and kind.",
    ];
    const engine = new EndgameEngine(mock);

    const { state: afterEpilogue, epilogue } = await engine.generateEpilogue(
      finishedGame()
    );
    const result = await engine.generateReportCard(afterEpilogue, epilogue);

    expect(result.state.phase).toBe("report_card");
    expect(result.reportCard).toContain("# Luna");
    expect(result.reportCard).toContain("Personality");
    // Epilogue and report card route to their dedicated model roles.
    expect(mock.roleCalls).toEqual(["epilogue", "report_card"]);
  });
});
