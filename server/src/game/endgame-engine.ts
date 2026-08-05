import type { GameState, GameEvent } from "../types.js";
import { transition } from "./state-machine.js";
import {
  buildAlbumContext,
  buildEpilogueContext,
  buildReportCardContext,
  buildCpsContext,
  buildRemovalEpilogueContext,
} from "./context-assembler.js";
import type { LLMClient } from "../llm/client.js";

export interface AlbumData {
  partnerName: string;
  relationshipSummary: string;
  moments: Array<{
    age: number;
    title: string;
    description: string;
    momentType: string;
    visualPrompt: string;
  }>;
}

/**
 * Drives the endgame phases: the epilogue narrative, the optional adult
 * conversations, and the final report card. It mirrors the ConversationEngine
 * pattern — pure state transitions on one side, LLM calls behind the LLMClient
 * interface on the other.
 */
const VALID_CPS_OUTCOMES = ["stay", "safety_plan", "removal"] as const;
type CpsOutcome = (typeof VALID_CPS_OUTCOMES)[number];

/**
 * Validate the raw `outcome` field from the CPS caseworker LLM. Any value
 * outside the three valid outcomes (missing, misspelled, wrong type) falls
 * back to "safety_plan" — the safe middle ground. Never defaults to
 * "removal": that is the most severe, irreversible outcome and must only
 * come from an explicit, well-formed LLM determination.
 */
function coerceCpsOutcome(raw: unknown): CpsOutcome {
  if (typeof raw === "string" && (VALID_CPS_OUTCOMES as readonly string[]).includes(raw)) {
    return raw as CpsOutcome;
  }
  return "safety_plan";
}

/** Coerce the `determination` narrative field to a safe non-empty string. */
function coerceDetermination(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw;
  return "The caseworker's determination could not be generated. A safety plan will be put in place while the review is completed.";
}

export class EndgameEngine {
  constructor(private llm: LLMClient) {}

  /**
   * Generate the 3-4 paragraph narrative of the child's adult life and
   * transition the game into the `epilogue` phase. The generated text is
   * threaded through the action so callers can persist or display it.
   */
  async generateEpilogue(
    state: GameState,
    onChunk?: (chunk: string) => void
  ): Promise<{ state: GameState; epilogue: string }> {
    /**
     * There is exactly one epilogue per childhood, so a repeat request replays
     * it rather than writing a new one.
     *
     * Seen in production 2026-08-05 01:11:10Z: a game that had already reached
     * its epilogue and report card received a second POST /epilogue. It ran the
     * LLM for 52.9 seconds, produced a whole new ending, then lost it to
     * "Invalid transition: START_EPILOGUE from phase report_card" — the player
     * got an error where their ending should have been, and we paid for the
     * generation. Duplicate requests are ordinary here: the client can reach
     * this call from the manual "end childhood" button, the `arc_complete`
     * route, and nextEvent auto-advancing out of `event_intro`, so a refresh or
     * two triggers racing is enough.
     *
     * Widening the START_EPILOGUE guard to accept report_card would be worse
     * than the error it removes: the report card is generated FROM the
     * epilogue, so a second, different ending would leave the player holding a
     * report card describing an ending they never read.
     *
     * The stored text is still pushed through onChunk — a client that
     * reconnected and subscribed to the stream must render something rather
     * than sit on a blank ending screen.
     */
    if (state.epilogue) {
      onChunk?.(state.epilogue);
      return { state, epilogue: state.epilogue };
    }

    const ctx = buildEpilogueContext(state);
    const epilogue = await this.llm.completeResponse(
      ctx.system,
      ctx.userMessage,
      undefined,
      "epilogue",
      onChunk
    );
    const next = transition(state, { type: "START_EPILOGUE", epilogue });
    return { state: next, epilogue };
  }

  /**
   * Build an adult-chat scenario as a GameEvent and transition into the
   * `adult_chat` phase. The same kid-context flow drives the now-adult child's
   * responses, with `currentEvent.description` carrying the scenario.
   */
  async startAdultConversation(
    state: GameState,
    scenario: string
  ): Promise<GameState> {
    const event: GameEvent = {
      eventNumber: state.currentEventNumber + 1,
      age: 25,
      description: scenario,
      setting: "Adulthood",
      trigger: "A conversation with your grown child",
    };
    return transition(state, { type: "START_ADULT_CHAT", event });
  }

  /**
   * Generate the final report card from the identity timeline + epilogue and
   * transition into the `report_card` phase.
   */
  async generateReportCard(
    state: GameState,
    epilogue: string,
    onChunk?: (chunk: string) => void
  ): Promise<{ state: GameState; reportCard: string }> {
    const ctx = buildReportCardContext(state, epilogue);
    const reportCard = await this.llm.completeResponse(
      ctx.system,
      ctx.userMessage,
      undefined,
      "report_card",
      onChunk
    );
    const next = transition(state, { type: "SHOW_REPORT_CARD", reportCard });
    return { state: next, reportCard };
  }

  /**
   * Extract album data (partner info + key moments) from a completed game
   * using the LLM. Returns structured data for building the family photo album.
   */
  async generateAlbumData(
    state: GameState,
    epilogue: string,
    reportCard: string,
    partnerDisplayName?: string
  ): Promise<AlbumData> {
    const ctx = buildAlbumContext(state, epilogue, reportCard, partnerDisplayName);
    return this.llm.completeJson<AlbumData>(ctx.system, ctx.userMessage, "album");
  }

  /**
   * Dark Play intervention ladder — Rung 3. The CPS caseworker deliberates
   * over every piece of evidence gathered so far and returns a structured
   * determination. `outcome` is validated defensively: the LLM's JSON is
   * untrusted input, and a malformed/missing outcome must never silently
   * become "removal" (the most severe, irreversible result) — it falls back
   * to "safety_plan" instead. Called from the `debrief` phase.
   */
  async runCpsReview(
    state: GameState,
    _onChunk?: (chunk: string) => void
  ): Promise<{ state: GameState; text: string; outcome: "stay" | "safety_plan" | "removal" }> {
    const ctx = buildCpsContext(state);
    const raw = await this.llm.completeJson<{ outcome?: unknown; determination?: unknown }>(
      ctx.system,
      ctx.userMessage,
      "cps_caseworker"
    );
    const outcome = coerceCpsOutcome(raw?.outcome);
    const text = coerceDetermination(raw?.determination);

    let next = transition(state, { type: "ENTER_INTERVENTION", rung: 3, text });
    next = transition(next, { type: "SET_CPS_OUTCOME", outcome });

    return { state: next, text, outcome };
  }

  /**
   * Terminal removal epilogue — used instead of generateEpilogue when
   * cpsOutcome === "removal". Called from the `cps_review` phase (see the
   * START_EPILOGUE guard widening in state-machine.ts).
   */
  async generateRemovalEpilogue(
    state: GameState,
    onChunk?: (chunk: string) => void
  ): Promise<{ state: GameState; epilogue: string }> {
    const ctx = buildRemovalEpilogueContext(state);
    const epilogue = await this.llm.completeResponse(
      ctx.system,
      ctx.userMessage,
      undefined,
      "epilogue",
      onChunk
    );
    const next = transition(state, { type: "START_EPILOGUE", epilogue });
    return { state: next, epilogue };
  }
}
