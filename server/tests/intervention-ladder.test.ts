import { describe, it, expect } from "vitest";
import {
  createGame, transition, selectDueRung,
  CONSULT_THRESHOLD, THERAPY_THRESHOLD, CPS_THRESHOLD,
} from "../src/game/state-machine.js";
import { InMemoryGameRepository } from "../src/db/repository.js";

describe("intervention ladder — rung selection", () => {
  it("no rung is due below the first threshold", () => {
    expect(selectDueRung(CONSULT_THRESHOLD - 1, 0)).toBe(0);
  });
  it("rung 1 is due at the consult threshold when none has fired", () => {
    expect(selectDueRung(CONSULT_THRESHOLD, 0)).toBe(1);
  });
  it("a fired rung does not re-fire; only a higher crossed threshold does", () => {
    expect(selectDueRung(THERAPY_THRESHOLD, 1)).toBe(2);   // therapy now due
    expect(selectDueRung(THERAPY_THRESHOLD, 2)).toBe(0);   // already fired therapy, cps not yet crossed
    expect(selectDueRung(CPS_THRESHOLD, 2)).toBe(3);       // cps due
  });
  it("selects the HIGHEST crossed rung, not the next one up", () => {
    // A player who spikes straight past two thresholds jumps to the higher rung.
    expect(selectDueRung(CPS_THRESHOLD, 0)).toBe(3);
  });
});

describe("intervention ladder — phase transitions", () => {
  it("ENTER_INTERVENTION moves debrief into the matching phase, stores text, marks the rung fired", () => {
    const s = { ...createGame("Kai"), phase: "debrief" as const };
    const next = transition(s, { type: "ENTER_INTERVENTION", rung: 1, text: "the psychologist speaks" });
    expect(next.phase).toBe("consult");
    expect(next.interventionText).toBe("the psychologist speaks");
    expect(next.highestRungFired).toBe(1);
  });
  it("ENTER_INTERVENTION rung 2 seeds the therapy session with the therapist opening", () => {
    const s = { ...createGame("Kai"), phase: "debrief" as const };
    const next = transition(s, { type: "ENTER_INTERVENTION", rung: 2, text: "welcome, let's talk" });
    expect(next.phase).toBe("therapy");
    expect(next.interventionText).toBeNull();
    expect(next.therapyMessages).toEqual([{ speaker: "therapist", content: "welcome, let's talk" }]);
    expect(next.highestRungFired).toBe(2);
  });
  it("APPEND_THERAPY_MESSAGE adds a parent then therapist turn", () => {
    let s = { ...createGame("Kai"), phase: "debrief" as const };
    s = transition(s, { type: "ENTER_INTERVENTION", rung: 2, text: "open" });
    s = transition(s, { type: "APPEND_THERAPY_MESSAGE", speaker: "parent", content: "I hear you" });
    s = transition(s, { type: "APPEND_THERAPY_MESSAGE", speaker: "therapist", content: "thank you" });
    expect(s.therapyMessages.map((m) => m.speaker)).toEqual(["therapist", "parent", "therapist"]);
  });
  it("END_INTERVENTION returns to event_intro and clears text + therapy transcript", () => {
    let s = { ...createGame("Kai"), phase: "debrief" as const };
    s = transition(s, { type: "ENTER_INTERVENTION", rung: 2, text: "therapy" });
    s = transition(s, { type: "APPEND_THERAPY_MESSAGE", speaker: "parent", content: "ok" });
    const next = transition(s, { type: "END_INTERVENTION" });
    expect(next.phase).toBe("event_intro");
    expect(next.interventionText).toBeNull();
    expect(next.therapyMessages).toEqual([]);
  });
  it("SET_CPS_OUTCOME records the determination", () => {
    let s = { ...createGame("Kai"), phase: "debrief" as const };
    s = transition(s, { type: "ENTER_INTERVENTION", rung: 3, text: "cps" });
    const next = transition(s, { type: "SET_CPS_OUTCOME", outcome: "removal" });
    expect(next.cpsOutcome).toBe("removal");
  });
});

describe("intervention ladder — persistence (in-memory repo)", () => {
  // This assertion used to read `interventionText` loads as *null*, codifying
  // the omission rather than the intent: the column simply did not exist, so
  // the ladder's other two pieces of state survived a reload and this one did
  // not. Migration 019 adds it; the round trip is now symmetric.
  it("round-trips highestRungFired, cpsOutcome, therapyMessages and interventionText", async () => {
    const repo = new InMemoryGameRepository();
    let s = createGame("Kai");
    s = {
      ...s,
      highestRungFired: 2,
      cpsOutcome: "safety_plan",
      interventionText: "the psychologist's words to the parents",
      therapyMessages: [{ speaker: "therapist", content: "let's talk" }],
    };
    await repo.saveGame(s);
    const loaded = await repo.loadGame(s.id);
    expect(loaded?.highestRungFired).toBe(2);
    expect(loaded?.cpsOutcome).toBe("safety_plan");
    expect(loaded?.therapyMessages).toEqual([{ speaker: "therapist", content: "let's talk" }]);
    expect(loaded?.interventionText).toBe("the psychologist's words to the parents");
  });

  it("keeps interventionText null when there is none", async () => {
    const repo = new InMemoryGameRepository();
    const s = createGame("Kai");
    await repo.saveGame(s);
    expect((await repo.loadGame(s.id))?.interventionText).toBeNull();
  });
});
