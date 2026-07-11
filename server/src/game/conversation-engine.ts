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
import { detectGroomingPattern, detectConcerningTrajectory } from "../safety/pattern-detection.js";
import type { ModerationResult } from "../safety/moderation.js";
import type { TrajectoryResult } from "../safety/pattern-detection.js";

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

  /**
   * Ends the current scene: updates the Identity Document (Psychologist),
   * the memory summary, checks for a grooming pattern across the whole
   * scene (runs alongside the Psychologist, same scene transcript), and then
   * — once the Identity Document reflects this scene — checks whether the
   * child's developing trajectory is trending toward callousness/manipulation
   * (descriptive, never diagnostic; see pattern-detection.ts). A sustained
   * concerning trajectory (TRAJECTORY_CHECKED tracks a streak, not a single
   * scene) queues `pendingGuidance` on the state, which the World Manager
   * reads on the next event generation to weave in a side character giving
   * good advice — delivered diegetically, never as meta-text to the player.
   * The caller (REST route / socket handler) is responsible for acting on
   * `groomingCheck.flagged` — this method only classifies, it doesn't have
   * access to repo/IP-ban side effects.
   */
  async endFamilyChat(
    state: GameState,
    onChunk?: (chunk: string) => void
  ): Promise<{ state: GameState; groomingCheck: ModerationResult; trajectory: TrajectoryResult }> {
    let next = transition(state, { type: "END_FAMILY_CHAT" });
    const psychCtx = buildPsychologistContext(next);
    const memCtx = buildMemorySummarizerContext(next);

    const [updatedDoc, memorySummary, groomingCheck] = await Promise.all([
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
      detectGroomingPattern(this.llm, next),
    ]);

    next = transition(next, { type: "IDENTITY_UPDATED", document: updatedDoc, memorySummary });

    // Needs the just-updated document, so this runs after the transition
    // above rather than in the same Promise.all as the other three.
    const trajectory = await detectConcerningTrajectory(this.llm, next);
    next = transition(next, {
      type: "TRAJECTORY_CHECKED",
      concerning: trajectory.severity === "notable" || trajectory.severity === "significant",
      guidanceSeed: trajectory.guidanceSeed,
    });

    return { state: next, groomingCheck, trajectory };
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
