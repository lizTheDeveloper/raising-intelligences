/**
 * Asking for an epilogue that already exists must return the one they got.
 *
 * Production, 2026-08-05 01:11:10Z:
 *   epilogue_error — "Invalid transition: START_EPILOGUE from phase report_card"
 *
 * That game (ba7007a5) had already reached its ending: epilogue at 00:56:40,
 * report card at 01:02:21, then a second POST /epilogue at 01:11:10. The second
 * request ran the LLM for 52.9 seconds, produced a whole new ending, and then
 * threw it away on the state-machine guard — the player got an error where
 * their epilogue should have been, and we paid for the generation.
 *
 * The client has several ways to reach this call — the manual "end childhood"
 * button, the `arc_complete` route, and nextEvent auto-advancing from
 * `event_intro` — so a duplicate POST is an ordinary event (a refresh, a
 * reconnect, two triggers racing), not a bug in itself.
 *
 * Fixing this by adding `report_card` to the allowed phases would be wrong and
 * worse than the error. The report card is GENERATED FROM the epilogue, so a
 * regenerated, different ending would leave the player holding a report card
 * that describes an ending they never read. There is exactly one epilogue per
 * childhood; the second request must replay it, not rewrite it.
 */
import { describe, it, expect, vi } from "vitest";
import { EndgameEngine } from "../src/game/endgame-engine.js";
import { createGame, transition } from "../src/game/state-machine.js";
import type { LLMClient } from "../src/llm/client.js";

const ORIGINAL = "They grew up, and the house stayed warm.";

function fakeLlm(reply: string) {
  const completeResponse = vi.fn(
    async (
      _s: string,
      _u: string,
      _m?: number,
      _r?: unknown,
      onChunk?: (c: string) => void,
    ) => {
      onChunk?.(reply);
      return reply;
    },
  );
  return {
    client: { completeResponse, completeJson: vi.fn() } as unknown as LLMClient,
    completeResponse,
  };
}

/** A game that has already reached its ending and had a report card made. */
function gameAtReportCard() {
  const started = { ...createGame("Kai"), phase: "debrief" as const };
  const withEpilogue = transition(started, { type: "START_EPILOGUE", epilogue: ORIGINAL });
  return { ...withEpilogue, phase: "report_card" as const };
}

describe("an epilogue is generated once per childhood", () => {
  it("replays the existing epilogue instead of erroring", async () => {
    const { client, completeResponse } = fakeLlm("a SECOND, different ending");
    const engine = new EndgameEngine(client);

    const result = await engine.generateEpilogue(gameAtReportCard());

    expect(
      result.epilogue,
      "the player was handed a different ending than the one their report card was written from",
    ).toBe(ORIGINAL);
    expect(
      completeResponse,
      "burned a paid 50s generation to produce an ending that gets thrown away",
    ).not.toHaveBeenCalled();
  });

  it("streams the stored epilogue so a reconnecting client still renders it", async () => {
    const { client } = fakeLlm("unused");
    const chunks: string[] = [];

    await new EndgameEngine(client).generateEpilogue(gameAtReportCard(), (c) => chunks.push(c));

    expect(
      chunks.join(""),
      "the client subscribed to a stream that never emitted — a blank ending screen",
    ).toBe(ORIGINAL);
  });

  it("does not throw from any phase once the epilogue exists", async () => {
    // The specific crash was from report_card, but the same duplicate POST can
    // land on adult_chat or epilogue itself depending on where the player is.
    const { client } = fakeLlm("unused");
    const engine = new EndgameEngine(client);

    for (const phase of ["report_card", "epilogue", "adult_chat"] as const) {
      const state = { ...gameAtReportCard(), phase };
      await expect(
        engine.generateEpilogue(state),
        `a duplicate epilogue request from ${phase} still errors`,
      ).resolves.toMatchObject({ epilogue: ORIGINAL });
    }
  });

  it("still generates the first epilogue normally", async () => {
    // Guard against "fixing" this by making generateEpilogue a no-op.
    const { client, completeResponse } = fakeLlm("the real first ending");
    const state = { ...createGame("Kai"), phase: "debrief" as const };

    const result = await new EndgameEngine(client).generateEpilogue(state);

    expect(result.epilogue).toBe("the real first ending");
    expect(result.state.phase).toBe("epilogue");
    expect(completeResponse).toHaveBeenCalledTimes(1);
  });
});
