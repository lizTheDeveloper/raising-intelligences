import { describe, it, expect } from "vitest";
import {
  buildKidContext,
  buildPsychologistContext,
} from "../src/game/context-assembler.js";
import { createGame, transition } from "../src/game/state-machine.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase and are standing over the pieces.",
  setting: "Living room",
  trigger: "Accident while playing",
};

describe("buildKidContext", () => {
  it("includes child name, age, and event in system prompt", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildKidContext(state);
    expect(ctx.system).toContain("Luna");
    expect(ctx.system).toContain("4-year-old");
    expect(ctx.system).toContain("broke a vase");
  });

  it("includes identity document when present", () => {
    let state = createGame("Luna");
    state.identityDocument = "Core beliefs: the world is safe.";
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildKidContext(state);
    expect(ctx.system).toContain("Core beliefs: the world is safe.");
  });

  it("formats conversation history as messages array", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "It's okay, accidents happen.",
    });
    state = transition(state, {
      type: "KID_MESSAGE",
      content: "I didn't mean to!",
    });
    const ctx = buildKidContext(state);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]).toEqual({
      role: "user",
      content: "Parent 1: It's okay, accidents happen.",
    });
    expect(ctx.messages[1]).toEqual({ role: "assistant", content: "I didn't mean to!" });
  });

  it("only includes messages visible to the kid in current chat context", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "shared message",
    });
    const ctx = buildKidContext(state);
    expect(ctx.messages).toHaveLength(1);
  });
});

describe("buildPsychologistContext", () => {
  it("includes all messages from the event including private sidebars", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "shared message",
    });
    state = transition(state, { type: "START_SIDEBAR", parent: "parent2" });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent2",
      content: "private message",
    });
    state = transition(state, { type: "END_SIDEBAR" });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    const ctx = buildPsychologistContext(state);
    expect(ctx.userMessage).toContain("shared message");
    expect(ctx.userMessage).toContain("private message");
    expect(ctx.userMessage).toContain("[Private conversation with Parent 2]");
  });

  it("includes current identity document for incremental update", () => {
    let state = createGame("Luna");
    state.identityDocument = "Core beliefs: the world is safe.";
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    const ctx = buildPsychologistContext(state);
    expect(ctx.userMessage).toContain("Core beliefs: the world is safe.");
  });
});
