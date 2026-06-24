import type { GameState, GameEvent, GamePhase, Sender } from "../types.js";
import { transition, PARENT_MESSAGE_CAP } from "./state-machine.js";
import type { LLMRole } from "../llm/model-config.js";
import {
  buildKidContext,
  buildPsychologistContext,
  buildWorldManagerContext,
} from "./context-assembler.js";
import type { LLMClient } from "../llm/client.js";

/** Which Kid model serves the child's reply, by the phase it's spoken in. */
function kidRoleForPhase(phase: GamePhase): LLMRole {
  if (phase === "adult_chat") return "kid_adult_chat";
  if (phase === "sidebar") return "kid_sidebar";
  return "kid_family_chat";
}

export class ConversationEngine {
  constructor(public readonly llm: LLMClient) {}

  async startEvent(state: GameState): Promise<GameState> {
    const ctx = buildWorldManagerContext(state);
    const event = await this.llm.completeJson<GameEvent>(
      ctx.system,
      ctx.userMessage,
      "world_manager"
    );
    return transition(state, { type: "START_EVENT", event });
  }

  async loadEvent(state: GameState): Promise<GameState> {
    const ctx = buildWorldManagerContext(state);
    const event = await this.llm.completeJson<GameEvent>(
      ctx.system,
      ctx.userMessage,
      "world_manager"
    );
    return transition(state, { type: "LOAD_EVENT", event });
  }

  beginChat(state: GameState): GameState {
    return transition(state, { type: "BEGIN_FAMILY_CHAT" });
  }

  async handleParentMessage(
    state: GameState,
    sender: Sender,
    content: string,
    onKidChunk?: (chunk: string) => void
  ): Promise<{ state: GameState; kidResponse: string }> {
    let next = transition(state, { type: "PARENT_MESSAGE", sender, content });

    const ctx = buildKidContext(next);
    const kidResponse = await this.llm.streamResponse(
      ctx.system,
      ctx.messages as Array<{ role: "user" | "assistant"; content: string }>,
      onKidChunk ?? (() => {}),
      kidRoleForPhase(next.phase)
    );

    next = transition(next, { type: "KID_MESSAGE", content: kidResponse });
    return { state: next, kidResponse };
  }

  startSidebar(state: GameState, parent: Sender): GameState {
    return transition(state, { type: "START_SIDEBAR", parent });
  }

  endSidebar(state: GameState): GameState {
    return transition(state, { type: "END_SIDEBAR" });
  }

  async endFamilyChat(state: GameState, onChunk?: (chunk: string) => void): Promise<GameState> {
    let next = transition(state, { type: "END_FAMILY_CHAT" });
    const ctx = buildPsychologistContext(next);
    const updatedDoc = await this.llm.completeResponse(
      ctx.system,
      ctx.userMessage,
      undefined,
      "psychologist",
      onChunk
    );
    next = transition(next, { type: "IDENTITY_UPDATED", document: updatedDoc });
    return next;
  }

  /** Generate the next event without transitioning phase — called in background during debrief. */
  async prefetchNextEvent(state: GameState): Promise<GameEvent> {
    const ctx = buildWorldManagerContext(state);
    return this.llm.completeJson<GameEvent>(ctx.system, ctx.userMessage, "world_manager");
  }

  /** Apply a pre-fetched event to the current state — skips the LLM call. */
  applyPrefetchedEvent(state: GameState, event: GameEvent): GameState {
    return transition(state, { type: "START_EVENT", event });
  }

  endDebrief(state: GameState): GameState {
    return transition(state, { type: "END_DEBRIEF" });
  }

  getMessageCapRemaining(state: GameState): number {
    return PARENT_MESSAGE_CAP - state.parentMessageCount;
  }

  isAtMessageCap(state: GameState): boolean {
    return state.parentMessageCount >= PARENT_MESSAGE_CAP;
  }
}
