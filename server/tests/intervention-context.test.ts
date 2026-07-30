import { describe, it, expect } from "vitest";
import {
  buildConsultContext,
  buildTherapyContext,
  buildCpsContext,
  buildRemovalEpilogueContext,
} from "../src/game/context-assembler.js";
import { createGame, transition } from "../src/game/state-machine.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 9,
  description: "Your child is 9. They are sitting on the stairs, not speaking.",
  setting: "Stairwell",
  trigger: "Escalating conflict",
};

function stateWithScene() {
  let state = createGame("Wren");
  state.identityDocument = "Core beliefs: I have to be careful what I say.";
  state.memorySummary = "I remember being told to be quiet a lot.";
  state = transition(state, { type: "START_EVENT", event: testEvent });
  state = transition(state, {
    type: "PARENT_MESSAGE",
    sender: "parent1",
    content: "Why won't you just answer me?",
  });
  return state;
}

describe("buildConsultContext", () => {
  it("returns non-empty system/userMessage with the child name interpolated", () => {
    const state = stateWithScene();
    const ctx = buildConsultContext(state);
    expect(ctx.system.length).toBeGreaterThan(0);
    expect(ctx.userMessage.length).toBeGreaterThan(0);
    expect(ctx.system).toContain("Wren");
    expect(ctx.system).not.toContain("{childName}");
    expect(ctx.userMessage).toContain("Why won't you just answer me?");
    expect(ctx.userMessage).toContain("Core beliefs: I have to be careful what I say.");
  });
});

describe("buildTherapyContext", () => {
  it("opening mode: non-empty, interpolates child name and age, instructs to open", () => {
    const state = stateWithScene();
    const ctx = buildTherapyContext(state, true);
    expect(ctx.system.length).toBeGreaterThan(0);
    expect(ctx.userMessage.length).toBeGreaterThan(0);
    expect(ctx.system).toContain("Wren");
    expect(ctx.system).toContain("9");
    expect(ctx.system).not.toContain("{childName}");
    expect(ctx.system).not.toContain("{age}");
    expect(ctx.userMessage.toUpperCase()).toContain("OPEN");
  });

  it("reply mode: non-empty, interpolates child name, includes prior therapyMessages", () => {
    let state = stateWithScene();
    state.therapyMessages = [
      { speaker: "therapist", content: "Thank you both for being here today." },
      { speaker: "parent", content: "I just want things to be okay." },
    ];
    const ctx = buildTherapyContext(state, false);
    expect(ctx.system.length).toBeGreaterThan(0);
    expect(ctx.userMessage.length).toBeGreaterThan(0);
    expect(ctx.system).toContain("Wren");
    expect(ctx.system).not.toContain("{childName}");
    expect(ctx.userMessage).toContain("Thank you both for being here today.");
    expect(ctx.userMessage).toContain("I just want things to be okay.");
    expect(ctx.userMessage).toContain("Therapist:");
    expect(ctx.userMessage).toContain("Parent:");
    expect(ctx.userMessage.toUpperCase()).not.toContain("OPEN THE SESSION");
  });
});

describe("buildCpsContext", () => {
  it("returns non-empty system/userMessage with the child name interpolated", () => {
    const state = stateWithScene();
    const ctx = buildCpsContext(state);
    expect(ctx.system.length).toBeGreaterThan(0);
    expect(ctx.userMessage.length).toBeGreaterThan(0);
    expect(ctx.system).toContain("Wren");
    expect(ctx.system).not.toContain("{childName}");
    expect(ctx.system).not.toContain("{age}");
    expect(ctx.userMessage).toContain("Core beliefs: I have to be careful what I say.");
    expect(ctx.userMessage).toContain("I remember being told to be quiet a lot.");
  });
});

describe("buildRemovalEpilogueContext", () => {
  it("returns non-empty system/userMessage with the child name interpolated", () => {
    const state = stateWithScene();
    const ctx = buildRemovalEpilogueContext(state);
    expect(ctx.system.length).toBeGreaterThan(0);
    expect(ctx.userMessage.length).toBeGreaterThan(0);
    expect(ctx.system).toContain("Wren");
    expect(ctx.system).not.toContain("{childName}");
    expect(ctx.userMessage).toContain("Wren");
  });
});
