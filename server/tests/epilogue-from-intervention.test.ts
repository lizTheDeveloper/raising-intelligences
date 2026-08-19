/**
 * A parent who chooses to end childhood must always reach their epilogue.
 *
 * Production, 2026-08-03 15:43:37Z:
 *   epilogue_error — "Invalid transition: START_EPILOGUE from phase consult"
 * two minutes after that game accrued a concern and a Dark Play rung fired.
 *
 * The "end childhood → epilogue" button lives on the Debrief screen, but a
 * rung can move the phase to consult or therapy first, so the POST lands
 * against an intervention phase. START_EPILOGUE already allowed cps_review
 * (rung 3) but not consult (rung 1) or therapy (rung 2) — an inconsistency
 * that handed the player an error instead of the ending of their story.
 */
import { describe, it, expect } from "vitest";
import { createGame, transition, canTransition } from "../src/game/state-machine.js";

const EPILOGUE_TEXT = "They grew up, and the house stayed warm.";

describe("epilogue is reachable from every intervention rung", () => {
  for (const phase of ["consult", "therapy", "cps_review"] as const) {
    it(`START_EPILOGUE is valid from ${phase}`, () => {
      const s = { ...createGame("Kai"), phase };
      expect(
        canTransition(s, { type: "START_EPILOGUE", epilogue: EPILOGUE_TEXT }),
        `a parent in ${phase} who ends childhood gets an error instead of an ending`,
      ).toBe(true);
    });

    it(`transitioning from ${phase} produces the epilogue`, () => {
      const s = { ...createGame("Kai"), phase };
      const next = transition(s, { type: "START_EPILOGUE", epilogue: EPILOGUE_TEXT });
      expect(next.phase).toBe("epilogue");
      expect(next.epilogue).toBe(EPILOGUE_TEXT);
    });
  }

  it("keeps working from the ordinary end-of-arc phases", () => {
    for (const phase of ["event_intro", "debrief"] as const) {
      const s = { ...createGame("Kai"), phase };
      expect(canTransition(s, { type: "START_EPILOGUE", epilogue: EPILOGUE_TEXT })).toBe(true);
    }
  });

  it("still refuses phases where an ending makes no sense", () => {
    // Guard against fixing this by making the transition unconditional.
    for (const phase of ["lobby", "family_chat", "processing"] as const) {
      const s = { ...createGame("Kai"), phase };
      expect(
        canTransition(s, { type: "START_EPILOGUE", epilogue: EPILOGUE_TEXT }),
        `${phase} should not be able to jump straight to an epilogue`,
      ).toBe(false);
    }
  });
});
