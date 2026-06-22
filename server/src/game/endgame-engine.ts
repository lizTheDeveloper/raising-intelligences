import type { GameState, GameEvent } from "../types.js";
import { transition } from "./state-machine.js";
import {
  buildEpilogueContext,
  buildReportCardContext,
} from "./context-assembler.js";
import type { LLMClient } from "../llm/client.js";

/**
 * Drives the endgame phases: the epilogue narrative, the optional adult
 * conversations, and the final report card. It mirrors the ConversationEngine
 * pattern — pure state transitions on one side, LLM calls behind the LLMClient
 * interface on the other.
 */
export class EndgameEngine {
  constructor(private llm: LLMClient) {}

  /**
   * Generate the 3-4 paragraph narrative of the child's adult life and
   * transition the game into the `epilogue` phase. The generated text is
   * threaded through the action so callers can persist or display it.
   */
  async generateEpilogue(
    state: GameState
  ): Promise<{ state: GameState; epilogue: string }> {
    const ctx = buildEpilogueContext(state);
    const epilogue = await this.llm.completeResponse(
      ctx.system,
      ctx.userMessage,
      undefined,
      "epilogue"
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
    epilogue: string
  ): Promise<{ state: GameState; reportCard: string }> {
    const ctx = buildReportCardContext(state, epilogue);
    const reportCard = await this.llm.completeResponse(
      ctx.system,
      ctx.userMessage,
      undefined,
      "report_card"
    );
    const next = transition(state, { type: "SHOW_REPORT_CARD", reportCard });
    return { state: next, reportCard };
  }
}
