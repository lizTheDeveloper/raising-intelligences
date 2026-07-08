import type { GameState, GameEvent, GamePhase, Sender } from "../types.js";
import { transition, PARENT_MESSAGE_CAP } from "./state-machine.js";
import type { LLMRole } from "../llm/model-config.js";
import {
  buildKidContext,
  buildPsychologistContext,
  buildMemorySummarizerContext,
  buildWorldManagerContext,
} from "./context-assembler.js";
import type { LLMClient } from "../llm/client.js";

/**
 * Validate and coerce raw JSON from the world-manager LLM into a GameEvent.
 * The LLM occasionally returns age as a string, omits optional fields, or
 * wraps the object in markdown fences — this guard catches all of those and
 * throws early with a clear message before the bad data reaches game state.
 */
function validateGameEvent(raw: unknown): GameEvent {
  if (!raw || typeof raw !== "object") {
    throw new Error("World manager returned a non-object response");
  }
  const e = raw as Record<string, unknown>;

  const age = typeof e.age === "number" ? e.age : Number(e.age);
  if (!Number.isFinite(age) || age < 0 || age > 30) {
    throw new Error(`World manager returned invalid age: ${e.age}`);
  }

  if (typeof e.description !== "string" || !e.description.trim()) {
    throw new Error("World manager response missing description");
  }
  if (typeof e.setting !== "string" || !e.setting.trim()) {
    throw new Error("World manager response missing setting");
  }
  if (typeof e.trigger !== "string" || !e.trigger.trim()) {
    throw new Error("World manager response missing trigger");
  }

  return {
    eventNumber: typeof e.eventNumber === "number" ? e.eventNumber : Number(e.eventNumber) || 0,
    age,
    description: e.description,
    setting: e.setting,
    trigger: e.trigger,
  };
}

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
    const raw = await this.llm.completeJson<unknown>(ctx.system, ctx.userMessage, "world_manager");
    const event = validateGameEvent(raw);
    return transition(state, { type: "START_EVENT", event });
  }

  async loadEvent(state: GameState): Promise<GameState> {
    const ctx = buildWorldManagerContext(state);
    const raw = await this.llm.completeJson<unknown>(ctx.system, ctx.userMessage, "world_manager");
    const event = validateGameEvent(raw);
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
    const psychCtx = buildPsychologistContext(next);
    const memCtx = buildMemorySummarizerContext(next);

    const [updatedDoc, memorySummary] = await Promise.all([
      this.llm.completeResponse(
        psychCtx.system,
        psychCtx.userMessage,
        undefined,
        "psychologist",
        onChunk
      ),
      this.llm.completeResponse(
        memCtx.system,
        memCtx.userMessage,
        undefined,
        "memory_summarizer"
      ).catch((err) => {
        console.error("Memory summarizer failed (non-fatal):", err);
        return undefined;
      }),
    ]);

    next = transition(next, { type: "IDENTITY_UPDATED", document: updatedDoc, memorySummary });
    return next;
  }

  /** Generate the next event without transitioning phase — called in background during debrief. */
  async prefetchNextEvent(state: GameState): Promise<GameEvent> {
    const ctx = buildWorldManagerContext(state);
    const raw = await this.llm.completeJson<unknown>(ctx.system, ctx.userMessage, "world_manager");
    return validateGameEvent(raw);
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
