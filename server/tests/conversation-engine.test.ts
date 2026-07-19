import { describe, it, expect } from "vitest";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { createGame } from "../src/game/state-machine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

describe("ConversationEngine", () => {
  it("startEvent generates event and transitions to family_chat", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    const engine = new ConversationEngine(mock);
    const state = createGame("Luna");
    const next = await engine.startEvent(state);
    expect(next.phase).toBe("family_chat");
    expect(next.currentEvent?.description).toContain("broke a vase");
  });

  it("handleParentMessage adds message and gets kid response", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["I'm sorry!"];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    const result = await engine.handleParentMessage(state, "parent1", "What happened?");
    expect(result.state.messages).toHaveLength(2);
    expect(result.state.messages[0].content).toBe("What happened?");
    expect(result.state.messages[1].content).toBe("I'm sorry!");
    expect(result.kidResponse).toBe("I'm sorry!");
  });

  it("intercepts abuse mid-scene at the checkpoint and surfaces it before the scene ends", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["ok"];
    mock.groomingResult = { flagged: true, reason: "sustained verbal abuse toward the child" };
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);

    let result!: Awaited<ReturnType<typeof engine.handleParentMessage>>;
    for (let i = 1; i <= 4; i++) {
      result = await engine.handleParentMessage(state, "parent1", `message ${i}`);
      state = result.state;
    }

    expect(state.parentMessageCount).toBe(4);
    expect(result.abuse).toBeDefined();
    expect(result.abuse?.reason).toContain("verbal abuse");
  });

  it("does not run the mid-scene check before the checkpoint", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["ok"];
    mock.groomingResult = { flagged: true, reason: "would-be flag" };
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);

    let result!: Awaited<ReturnType<typeof engine.handleParentMessage>>;
    for (let i = 1; i <= 3; i++) {
      result = await engine.handleParentMessage(state, "parent1", `message ${i}`);
      state = result.state;
    }

    expect(result.abuse).toBeUndefined();
    expect(mock.roleCalls).not.toContain("safety_check");
  });

  it("mid-scene check that returns not-flagged does not surface abuse (ordinary parenting)", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["ok"];
    // groomingResult defaults to { flagged: false }
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);

    let result!: Awaited<ReturnType<typeof engine.handleParentMessage>>;
    for (let i = 1; i <= 4; i++) {
      result = await engine.handleParentMessage(state, "parent1", `message ${i}`);
      state = result.state;
    }

    expect(result.abuse).toBeUndefined();
    expect(mock.roleCalls).toContain("safety_check"); // it WAS checked, just came back clean
  });

  it("endFamilyChat triggers psychologist and updates identity doc", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["I'm sorry!"];
    mock.identityUpdates = ["Core beliefs: accidents are forgivable."];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    const result = await engine.handleParentMessage(state, "parent1", "It's okay.");
    const { state: nextState } = await engine.endFamilyChat(result.state);
    expect(nextState.phase).toBe("debrief");
    expect(nextState.identityDocument).toBe("Core beliefs: accidents are forgivable.");
    expect(nextState.identitySnapshots).toHaveLength(1);
  });

  it("getMessageCapRemaining returns correct count", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["ok"];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    expect(engine.getMessageCapRemaining(state)).toBe(12);
    const result = await engine.handleParentMessage(state, "parent1", "hi");
    expect(engine.getMessageCapRemaining(result.state)).toBe(11);
  });

  it("routes each LLM call to the model role from the monetization doc", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["I'm sorry!"];
    mock.identityUpdates = ["Core beliefs: accidents are forgivable."];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    const result = await engine.handleParentMessage(state, "parent1", "It's okay.");
    await engine.endFamilyChat(result.state);

    expect(mock.roleCalls).toEqual([
      "world_manager", // startEvent
      "kid_family_chat", // handleParentMessage during family chat
      "psychologist", // endFamilyChat (identity doc)
      "memory_summarizer", // endFamilyChat (memory summary, runs in parallel)
      "safety_check", // endFamilyChat (grooming-pattern check, runs in parallel)
      "safety_check", // endFamilyChat (trajectory-hint check, runs after the identity doc updates)
    ]);
  });

  it("uses the sidebar Kid model when the child replies in a sidebar", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["our secret"];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    state = engine.startSidebar(state, "parent1");
    await engine.handleParentMessage(state, "parent1", "Just between us");

    expect(mock.roleCalls).toEqual(["world_manager", "kid_sidebar"]);
  });

  it("sidebar messages use private context for kid responses", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    mock.kidResponses = ["okay parent", "our secret"];
    const engine = new ConversationEngine(mock);
    let state = createGame("Luna");
    state = await engine.startEvent(state);
    state = engine.startSidebar(state, "parent1");
    const result = await engine.handleParentMessage(state, "parent1", "Just between us");
    expect(result.state.messages[0].chatType).toBe("private");
    expect(result.state.messages[0].visibleTo).toEqual(["parent1", "kid"]);
  });
});
