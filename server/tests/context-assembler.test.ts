import { describe, it, expect } from "vitest";
import {
  buildKidContext,
  buildPsychologistContext,
  buildWorldManagerContext,
} from "../src/game/context-assembler.js";
import { createGame, transition } from "../src/game/state-machine.js";
import type { GameEvent, ParentPersonality } from "../src/types.js";

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

describe("buildKidContext - personalitySeed", () => {
  it("uses personalitySeed (not temperament) in the kid system prompt", () => {
    let state = createGame("Luna");
    state.personalitySeed = "She arrived in the world already vibrating.";
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildKidContext(state);
    expect(ctx.system).toContain("She arrived in the world already vibrating.");
    expect(ctx.system).not.toContain("{personalitySeed}");
    expect(ctx.system).not.toContain("{temperament}");
  });
});

describe("buildWorldManagerContext - personalitySeed and landmine section", () => {
  it("uses personalitySeed in the world manager prompt", () => {
    let state = createGame("Luna");
    state.personalitySeed = "Restless from day one.";
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildWorldManagerContext(state);
    expect(ctx.system).toContain("Restless from day one.");
    expect(ctx.system).not.toContain("{personalitySeed}");
    expect(ctx.system).not.toContain("{childTemperament}");
  });

  it("includes landmine section when parent1 has confessionals", () => {
    let state = createGame("Luna");
    const personality: ParentPersonality = {
      ocean: [2, 2, 2, 2, 2],
      confessional1: "I have a terrible temper.",
      confessional2: "I never felt good enough.",
    };
    state.parentPersonalities = { parent1: personality };
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildWorldManagerContext(state);
    expect(ctx.system).toContain("I have a terrible temper.");
    expect(ctx.system).toContain("I never felt good enough.");
    expect(ctx.system).toContain("Emotional landmines");
  });

  it("includes confessionals from both parents in landmine section", () => {
    let state = createGame("Luna");
    const p1: ParentPersonality = {
      ocean: [2, 2, 2, 2, 2],
      confessional1: "I grew up in chaos.",
      confessional2: "",
    };
    const p2: ParentPersonality = {
      ocean: [3, 3, 3, 3, 3],
      confessional1: "I was emotionally unavailable.",
      confessional2: "",
    };
    state.parentPersonalities = { parent1: p1, parent2: p2 };
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildWorldManagerContext(state);
    expect(ctx.system).toContain("I grew up in chaos.");
    expect(ctx.system).toContain("I was emotionally unavailable.");
  });

  it("omits landmine section when no confessionals are present", () => {
    let state = createGame("Luna");
    const personality: ParentPersonality = {
      ocean: [2, 2, 2, 2, 2],
      confessional1: "",
      confessional2: "",
    };
    state.parentPersonalities = { parent1: personality };
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildWorldManagerContext(state);
    expect(ctx.system).not.toContain("Emotional landmines");
    expect(ctx.system).not.toContain("{landmineSection}");
  });

  it("omits landmine section when parentPersonalities is empty", () => {
    let state = createGame("Luna");
    state.parentPersonalities = {};
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildWorldManagerContext(state);
    expect(ctx.system).not.toContain("Emotional landmines");
    expect(ctx.system).not.toContain("{landmineSection}");
  });
});
