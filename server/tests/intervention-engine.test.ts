import { describe, it, expect } from "vitest";
import { ConversationEngine } from "../src/game/conversation-engine.js";
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

/** A game that has finished a scene and landed back in `debrief` — the phase
 * every rung of the intervention ladder is entered from. */
function debriefState() {
  let state = createGame("Kai");
  state = transition(state, { type: "START_EVENT", event: testEvent });
  state = transition(state, { type: "END_FAMILY_CHAT" });
  state = transition(state, {
    type: "IDENTITY_UPDATED",
    document: "Core beliefs: the world is safe.",
  });
  return state;
}

describe("intervention ladder — ConversationEngine", () => {
  it("generateConsult enters Rung 1 from debrief", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["Let's talk about what I'm seeing in these scenes."];
    const engine = new ConversationEngine(mock);

    const result = await engine.generateConsult(debriefState());

    expect(result.text).toBeTruthy();
    expect(result.state.phase).toBe("consult");
    expect(result.state.highestRungFired).toBe(1);
  });

  it("openTherapy enters Rung 2 from debrief and seeds one therapist turn", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["Welcome, thank you both for being here today."];
    const engine = new ConversationEngine(mock);

    const result = await engine.openTherapy(debriefState());

    expect(result.text).toBeTruthy();
    expect(result.state.phase).toBe("therapy");
    expect(result.state.highestRungFired).toBe(2);
    expect(result.state.therapyMessages).toHaveLength(1);
    expect(result.state.therapyMessages[0].speaker).toBe("therapist");
  });

  it("therapistReply appends a parent turn then a therapist turn", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = [
      "Welcome, thank you both for being here today.",
      "I hear that you want to do better — let's talk about how.",
    ];
    const engine = new ConversationEngine(mock);

    let state = await engine.openTherapy(debriefState()).then((r) => r.state);
    const result = await engine.therapistReply(state, "I want to do better");

    expect(result.text).toBeTruthy();
    expect(result.state.therapyMessages).toHaveLength(3);
    expect(result.state.therapyMessages[1].speaker).toBe("parent");
    expect(result.state.therapyMessages[1].content).toBe("I want to do better");
    expect(result.state.therapyMessages[2].speaker).toBe("therapist");
    expect(result.state.therapyMessages[2].content).toBe(result.text);
  });
});

describe("intervention ladder — EndgameEngine.runCpsReview", () => {
  it("a well-formed 'removal' outcome is honored", async () => {
    const mock = new MockLLMClient();
    mock.cpsResult = {
      outcome: "removal",
      determination: "The department has determined removal is necessary.",
    };
    const engine = new EndgameEngine(mock);

    const result = await engine.runCpsReview(debriefState());

    expect(result.outcome).toBe("removal");
    expect(result.state.phase).toBe("cps_review");
    expect(result.state.cpsOutcome).toBe("removal");
    expect(result.text).toContain("removal is necessary");
  });

  it("a malformed outcome falls back to 'safety_plan', never 'removal'", async () => {
    const mock = new MockLLMClient();
    mock.cpsResult = {
      outcome: "banish",
      determination: "The caseworker's notes were unclear.",
    };
    const engine = new EndgameEngine(mock);

    const result = await engine.runCpsReview(debriefState());

    expect(result.outcome).toBe("safety_plan");
    expect(result.outcome).not.toBe("removal");
    expect(result.state.cpsOutcome).toBe("safety_plan");
    expect(result.state.phase).toBe("cps_review");
  });
});

describe("intervention ladder — EndgameEngine.generateRemovalEpilogue", () => {
  it("transitions from a realistic cps_review/removal state into epilogue", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["Kai grew up in foster care, carrying that day with them."];
    const engine = new EndgameEngine(mock);

    // Must start from the actual phase production calls this from
    // (cps_review with cpsOutcome "removal") — not a fresh event_intro
    // state, which would let START_EPILOGUE pass for the wrong reason and
    // mask a broken guard. This is the Task-1 START_EPILOGUE guard-widening
    // regression test.
    const state = { ...createGame("Kai"), phase: "cps_review" as const, cpsOutcome: "removal" as const };

    const result = await engine.generateRemovalEpilogue(state);

    expect(result.epilogue).toBeTruthy();
    expect(result.state.phase).toBe("epilogue");
  });
});
