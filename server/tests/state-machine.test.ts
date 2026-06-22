import { describe, it, expect } from "vitest";
import { createGame, transition, canTransition } from "../src/game/state-machine.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase and are standing over the pieces.",
  setting: "Living room",
  trigger: "Accident while playing",
};

describe("createGame", () => {
  it("creates a game in event_intro phase with empty state", () => {
    const state = createGame("Luna");
    expect(state.childName).toBe("Luna");
    expect(state.phase).toBe("event_intro");
    expect(state.currentEventNumber).toBe(0);
    expect(state.identityDocument).toBe("");
    expect(state.messages).toEqual([]);
    expect(state.parentMessageCount).toBe(0);
  });
});

describe("transition", () => {
  it("START_EVENT moves from event_intro to family_chat", () => {
    const state = createGame("Luna");
    const next = transition(state, { type: "START_EVENT", event: testEvent });
    expect(next.phase).toBe("family_chat");
    expect(next.currentEvent).toEqual(testEvent);
    expect(next.currentEventNumber).toBe(1);
    expect(next.events).toHaveLength(1);
  });

  it("PARENT_MESSAGE adds message and increments count", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "It's okay, accidents happen.",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.parentMessageCount).toBe(1);
    expect(state.messages[0].chatType).toBe("shared");
  });

  it("KID_MESSAGE adds message without incrementing parent count", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "KID_MESSAGE",
      content: "I didn't mean to!",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.parentMessageCount).toBe(0);
  });

  it("tracks parent message count toward cap of 12", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    for (let i = 0; i < 12; i++) {
      state = transition(state, {
        type: "PARENT_MESSAGE",
        sender: i % 2 === 0 ? "parent1" : "parent2",
        content: `message ${i}`,
      });
    }
    expect(state.parentMessageCount).toBe(12);
    expect(
      canTransition(state, {
        type: "PARENT_MESSAGE",
        sender: "parent1",
        content: "one more",
      })
    ).toBe(false);
  });

  it("START_SIDEBAR switches to sidebar phase", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "START_SIDEBAR", parent: "parent1" });
    expect(state.phase).toBe("sidebar");
    expect(state.sidebarActive).toBe("parent1");
    expect(state.sidebarUsed.parent1).toBe(true);
  });

  it("prevents second sidebar for same parent", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "START_SIDEBAR", parent: "parent1" });
    state = transition(state, { type: "END_SIDEBAR" });
    expect(canTransition(state, { type: "START_SIDEBAR", parent: "parent1" })).toBe(false);
    expect(canTransition(state, { type: "START_SIDEBAR", parent: "parent2" })).toBe(true);
  });

  it("sidebar messages are private to initiating parent", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "START_SIDEBAR", parent: "parent1" });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "Just between us...",
    });
    const msg = state.messages[state.messages.length - 1];
    expect(msg.chatType).toBe("private");
    expect(msg.visibleTo).toEqual(["parent1", "kid"]);
  });

  it("END_FAMILY_CHAT moves to processing", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    expect(state.phase).toBe("processing");
  });

  it("IDENTITY_UPDATED moves to debrief and snapshots", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, {
      type: "IDENTITY_UPDATED",
      document: "Core beliefs: the world is safe.",
    });
    expect(state.phase).toBe("debrief");
    expect(state.identityDocument).toBe("Core beliefs: the world is safe.");
    expect(state.identitySnapshots).toHaveLength(1);
    expect(state.identitySnapshots[0].eventNumber).toBe(1);
  });

  it("END_DEBRIEF resets for next event", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, {
      type: "IDENTITY_UPDATED",
      document: "Core beliefs: the world is safe.",
    });
    state = transition(state, { type: "END_DEBRIEF" });
    expect(state.phase).toBe("event_intro");
    expect(state.parentMessageCount).toBe(0);
    expect(state.sidebarUsed).toEqual({ parent1: false, parent2: false });
    expect(state.sidebarActive).toBeNull();
  });

  it("START_EPILOGUE can transition from event_intro or debrief", () => {
    let state = createGame("Luna");
    expect(canTransition(state, { type: "START_EPILOGUE", epilogue: "Test" })).toBe(true);

    // Transition to debrief phase
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, {
      type: "IDENTITY_UPDATED",
      document: "Core beliefs: the world is safe.",
    });
    expect(state.phase).toBe("debrief");
    expect(canTransition(state, { type: "START_EPILOGUE", epilogue: "Test" })).toBe(true);

    const epilogueState = transition(state, { type: "START_EPILOGUE", epilogue: "Test" });
    expect(epilogueState.phase).toBe("epilogue");
  });
});
