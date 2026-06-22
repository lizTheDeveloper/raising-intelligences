import type { GameState, GameEvent, Sender } from "../types.js";
import { transition } from "./state-machine.js";
import {
  buildKidContext,
  buildPsychologistContext,
  buildWorldManagerContext,
} from "./context-assembler.js";
import type { LLMClient } from "../llm/client.js";

const PARENT_MESSAGE_CAP = 12;

export class ConversationEngine {
  constructor(private llm: LLMClient) {}

  async startEvent(state: GameState): Promise<GameState> {
    const ctx = buildWorldManagerContext(state);
    const event = await this.llm.completeJson<GameEvent>(ctx.system, ctx.userMessage);
    return transition(state, { type: "START_EVENT", event });
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
      onKidChunk ?? (() => {})
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

  async endFamilyChat(state: GameState): Promise<GameState> {
    let next = transition(state, { type: "END_FAMILY_CHAT" });
    const ctx = buildPsychologistContext(next);
    const updatedDoc = await this.llm.completeResponse(ctx.system, ctx.userMessage);
    next = transition(next, { type: "IDENTITY_UPDATED", document: updatedDoc });
    return next;
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
