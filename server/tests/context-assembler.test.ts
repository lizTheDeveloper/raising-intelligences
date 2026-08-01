import { describe, it, expect } from "vitest";
import {
  buildKidContext,
  buildPsychologistContext,
  buildWorldManagerContext,
  buildAlbumContext,
  buildLandmineSection,
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

describe("cross-event message isolation", () => {
  const event1: GameEvent = {
    eventNumber: 1,
    age: 4,
    description: "Your toddler broke a vase.",
    setting: "Living room",
    trigger: "Accident",
  };
  const event2: GameEvent = {
    eventNumber: 2,
    age: 10,
    description: "Your child failed a test at school.",
    setting: "Kitchen",
    trigger: "Report card",
  };

  it("kid context only includes messages from the current event", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: event1 });
    state = transition(state, { type: "PARENT_MESSAGE", sender: "parent1", content: "oh no the vase" });
    state = transition(state, { type: "KID_MESSAGE", content: "me sowwy" });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, { type: "IDENTITY_UPDATED", document: "I break things." });
    state = transition(state, { type: "END_DEBRIEF" });

    state = transition(state, { type: "START_EVENT", event: event2 });
    state = transition(state, { type: "PARENT_MESSAGE", sender: "parent1", content: "let's talk about the test" });
    state = transition(state, { type: "KID_MESSAGE", content: "whatever, it was hard" });

    const ctx = buildKidContext(state);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].content).toContain("let's talk about the test");
    expect(ctx.messages[1].content).toBe("whatever, it was hard");
    expect(ctx.messages.some(m => m.content.includes("vase"))).toBe(false);
    expect(ctx.messages.some(m => m.content.includes("sowwy"))).toBe(false);
  });

  it("psychologist context only includes messages from the current event", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: event1 });
    state = transition(state, { type: "PARENT_MESSAGE", sender: "parent1", content: "oh no the vase" });
    state = transition(state, { type: "KID_MESSAGE", content: "me sowwy" });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, { type: "IDENTITY_UPDATED", document: "I break things." });
    state = transition(state, { type: "END_DEBRIEF" });

    state = transition(state, { type: "START_EVENT", event: event2 });
    state = transition(state, { type: "PARENT_MESSAGE", sender: "parent1", content: "let's talk about the test" });
    state = transition(state, { type: "END_FAMILY_CHAT" });

    const ctx = buildPsychologistContext(state);
    expect(ctx.userMessage).toContain("let's talk about the test");
    expect(ctx.userMessage).not.toContain("oh no the vase");
    expect(ctx.userMessage).not.toContain("me sowwy");
  });

  it("psychologist system prompt includes the current age", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: event2 });
    state = transition(state, { type: "END_FAMILY_CHAT" });

    const ctx = buildPsychologistContext(state);
    expect(ctx.system).toContain("currently 10 years old");
    expect(ctx.system).not.toContain("{age}");
  });

  it("kid context includes both events recap and memory summary when available", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: event1 });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, { type: "IDENTITY_UPDATED", document: "I break things.", memorySummary: "I remember when I broke the vase. Mom wasn't even mad." });
    state = transition(state, { type: "END_DEBRIEF" });
    state = transition(state, { type: "START_EVENT", event: event2 });

    const ctx = buildKidContext(state);
    expect(ctx.system).toContain("What you remember");
    expect(ctx.system).toContain("Your life so far:");
    expect(ctx.system).toContain("Age 4: Accident");
    expect(ctx.system).toContain("What sticks with you:");
    expect(ctx.system).toContain("I remember when I broke the vase");
  });

  it("kid context shows events list without memory section when no summary exists", () => {
    let state = createGame("Luna");
    state = transition(state, { type: "START_EVENT", event: event1 });
    state = transition(state, { type: "END_FAMILY_CHAT" });
    state = transition(state, { type: "IDENTITY_UPDATED", document: "I break things." });
    state = transition(state, { type: "END_DEBRIEF" });
    state = transition(state, { type: "START_EVENT", event: event2 });

    const ctx = buildKidContext(state);
    expect(ctx.system).toContain("What you remember");
    expect(ctx.system).toContain("Your life so far:");
    expect(ctx.system).toContain("Age 4: Accident");
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
    expect(ctx.system).not.toContain("A pressure point");
    expect(ctx.system).not.toContain("{landmineSection}");
  });

  it("omits landmine section when parentPersonalities is empty", () => {
    let state = createGame("Luna");
    state.parentPersonalities = {};
    state = transition(state, { type: "START_EVENT", event: testEvent });
    const ctx = buildWorldManagerContext(state);
    expect(ctx.system).not.toContain("A pressure point");
    expect(ctx.system).not.toContain("{landmineSection}");
  });
});

// Rationing: the confessed wound is what the player should feel standing out,
// which it cannot do if it sits in the model's context for all ten scenes.
// The schedule is derived from the game id, so these sweep every target event
// and assert the design property rather than one seed's firing numbers.
describe("landmine rationing", () => {
  const twoWounds: ParentPersonality = {
    ocean: [2, 2, 2, 2, 2],
    confessional1: "I have a terrible temper.",
    confessional2: "I never felt good enough.",
  };
  const otherWound: ParentPersonality = {
    ocean: [3, 3, 3, 3, 3],
    confessional1: "I was emotionally unavailable.",
    confessional2: "",
  };

  /** Which target event numbers (1..totalEvents) fire, for a given game id. */
  function firingsFor(
    id: string,
    personalities: { parent1?: ParentPersonality; parent2?: ParentPersonality }
  ): { event: number; section: string }[] {
    const base = createGame("Luna");
    base.id = id;
    base.parentPersonalities = personalities;

    const fired: { event: number; section: string }[] = [];
    for (let target = 1; target <= base.totalEvents; target++) {
      const section = buildLandmineSection({ ...base, currentEventNumber: target - 1 });
      if (section) fired.push({ event: target, section });
    }
    return fired;
  }

  it("fires at most twice, never in the first two scenes, never back to back", () => {
    // Sweep many game ids: the schedule is seeded, so one id proves nothing.
    for (let i = 0; i < 200; i++) {
      const fired = firingsFor(`game-${i}`, { parent1: twoWounds, parent2: otherWound });
      const events = fired.map((f) => f.event);

      expect(events.length).toBeLessThanOrEqual(2);
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const e of events) expect(e).toBeGreaterThanOrEqual(3);
      if (events.length === 2) expect(events[1] - events[0]).toBeGreaterThanOrEqual(3);
    }
  });

  it("stays silent on the scenes it does not fire on", () => {
    const fired = firingsFor("stable-id", { parent1: twoWounds });
    const firedEvents = new Set(fired.map((f) => f.event));

    // Present exactly where the schedule says, absent everywhere else.
    expect(firedEvents.size).toBeGreaterThan(0);
    for (let target = 1; target <= 10; target++) {
      const state = { ...createGame("Luna"), id: "stable-id", currentEventNumber: target - 1 };
      state.parentPersonalities = { parent1: twoWounds };
      const section = buildLandmineSection(state);
      if (firedEvents.has(target)) {
        expect(section).toContain("A pressure point");
      } else {
        expect(section).toBe("");
      }
    }
  });

  it("surfaces one wound at a time, never the whole list", () => {
    for (let i = 0; i < 50; i++) {
      for (const { section } of firingsFor(`game-${i}`, {
        parent1: twoWounds,
        parent2: otherWound,
      })) {
        const present = [
          twoWounds.confessional1,
          twoWounds.confessional2,
          otherWound.confessional1,
        ].filter((t) => section.includes(t));
        expect(present).toHaveLength(1);
      }
    }
  });

  it("never fires the same wound twice in one playthrough", () => {
    for (let i = 0; i < 200; i++) {
      const fired = firingsFor(`game-${i}`, { parent1: twoWounds, parent2: otherWound });
      const texts = fired.map((f) =>
        [twoWounds.confessional1, twoWounds.confessional2, otherWound.confessional1].find((t) =>
          f.section.includes(t)
        )
      );
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it("does not reshuffle parent 1's schedule when parent 2 joins later", () => {
    // Parent 2 can submit their personality after the story has started
    // (routes/game.ts), so the schedule must key on parent slot, not on
    // position in a growing array.
    for (let i = 0; i < 100; i++) {
      const soloFirings = firingsFor(`game-${i}`, { parent1: twoWounds });
      const bothFirings = firingsFor(`game-${i}`, { parent1: twoWounds, parent2: otherWound });

      // Whichever of parent 1's wounds was scheduled first keeps its scene.
      const firstSolo = soloFirings[0];
      const firstBoth = bothFirings[0];
      expect(firstSolo.event).toBe(firstBoth.event);
    }
  });

  it("is stable across repeated calls — a discarded prefetch burns nothing", () => {
    const state = { ...createGame("Luna"), id: "prefetch-id", currentEventNumber: 3 };
    state.parentPersonalities = { parent1: twoWounds, parent2: otherWound };
    const first = buildLandmineSection(state);
    for (let i = 0; i < 5; i++) {
      expect(buildLandmineSection(state)).toBe(first);
    }
  });

  it("leads with the constraint and does not lead with an imperative to hit the wound", () => {
    const fired = firingsFor("craft-id", { parent1: twoWounds });
    expect(fired.length).toBeGreaterThan(0);
    const section = fired[0].section;
    expect(section).toContain("It rhymes. It does not repeat.");
    expect(section).not.toContain("hit these specific pressure points");
    expect(section).not.toContain("confessed");
  });
});

describe("buildAlbumContext", () => {
  it("builds context for a solo game", () => {
    let state = createGame("Luna", "solo parent");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "Be careful with the vase!",
    });
    state = transition(state, {
      type: "KID_MESSAGE",
      content: "I broke it, sorry!",
    });
    state.identitySnapshots = [
      { eventNumber: 1, document: "I feel things deeply." },
    ];

    const ctx = buildAlbumContext(
      state,
      "Luna grew up to be a painter.",
      "Personality: sensitive and creative."
    );

    expect(ctx.system).toContain("Luna");
    expect(ctx.userMessage).toContain("solo-parent household");
    expect(ctx.userMessage).toContain("Luna grew up to be a painter.");
    expect(ctx.userMessage).toContain("Personality: sensitive and creative.");
    expect(ctx.userMessage).toContain("Be careful with the vase!");
    expect(ctx.userMessage).toContain("[Age 4]");
  });

  it("builds context for a multiplayer game with partner name", () => {
    let state = createGame("Luna", "romantic partners");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, {
      type: "PARENT_MESSAGE",
      sender: "parent1",
      content: "We need to talk about this.",
    });
    state.identitySnapshots = [
      { eventNumber: 1, document: "I watch them both carefully." },
    ];

    const ctx = buildAlbumContext(
      state,
      "Luna became a negotiator.",
      "Strengths: reads the room.",
      "Jordan"
    );

    expect(ctx.system).toContain("Luna");
    expect(ctx.userMessage).toContain("Jordan");
    expect(ctx.userMessage).toContain("co-parenting dynamic");
    expect(ctx.userMessage).not.toContain("solo-parent household");
    expect(ctx.userMessage).toContain("Luna became a negotiator.");
    expect(ctx.userMessage).toContain("Strengths: reads the room.");
  });
});
