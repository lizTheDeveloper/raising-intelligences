import type { GameState, GameEvent, Message, Sender } from "../types.js";
import { randomUUID } from "crypto";

export const PARENT_MESSAGE_CAP = 12;

export type GameAction =
  | { type: "LOAD_EVENT"; event: GameEvent }
  | { type: "BEGIN_FAMILY_CHAT" }
  | { type: "START_EVENT"; event: GameEvent }
  | { type: "PARENT_MESSAGE"; sender: Sender; content: string }
  | { type: "KID_MESSAGE"; content: string }
  | { type: "START_SIDEBAR"; parent: Sender }
  | { type: "END_SIDEBAR" }
  | { type: "END_FAMILY_CHAT" }
  | { type: "IDENTITY_UPDATED"; document: string; memorySummary?: string }
  | { type: "READY_UP"; player: Sender }
  | { type: "END_DEBRIEF" }
  | { type: "START_EPILOGUE"; epilogue: string }
  | { type: "START_ADULT_CHAT"; event: GameEvent }
  | { type: "SHOW_REPORT_CARD"; reportCard: string }
  | { type: "TRAJECTORY_CHECKED"; concerning: boolean; guidanceSeed: string }
  | { type: "CONCERN_ACCRUED"; delta: number };

/** Consecutive "notable"/"significant" scenes before guidance queues for the World Manager. */
const CONCERNING_STREAK_THRESHOLD = 2;

/** Dark Play Plan 2 — bounded concern accumulator (all tunable). */
export const CONCERN_MAX = 10;
/** Added to concernLevel when a scene ends in a Tier A "concern" verdict. */
export const CONCERN_INCREMENT = 2;
/** Subtracted from concernLevel when a scene ends clean (tier "none").
 * Smaller than the increment: repair is slower than harm (spec §7). */
export const CONCERN_DECAY = 1;

/** Signed change to concernLevel implied by a scene-end safety tier.
 * "block" ends the session and never accrues, so it maps to 0. */
export function concernDeltaForTier(tier: "block" | "concern" | "none"): number {
  if (tier === "concern") return CONCERN_INCREMENT;
  if (tier === "none") return -CONCERN_DECAY;
  return 0;
}

export function createGame(childName: string, relationshipType = "co-parents"): GameState {
  return {
    id: randomUUID(),
    phase: "event_intro",
    childName,
    childGender: "nonbinary",
    relationshipType,
    personalitySeed: "",
    parentPersonalities: {},
    currentEvent: null,
    currentEventNumber: 0,
    totalEvents: 10,
    identityDocument: "",
    identitySnapshots: [],
    memorySummary: "",
    events: [],
    messages: [],
    parentMessageCount: 0,
    sidebarUsed: { parent1: false, parent2: false },
    sidebarActive: null,
    concerningStreak: 0,
    concernLevel: 0,
    pendingGuidance: null,
    lastActivityAt: Date.now(),
  };
}

export function canTransition(state: GameState, action: GameAction): boolean {
  switch (action.type) {
    case "LOAD_EVENT":
      return state.phase === "event_intro" && state.currentEvent === null;
    case "BEGIN_FAMILY_CHAT":
      return state.phase === "event_intro" && state.currentEvent !== null;
    case "START_EVENT":
      return state.phase === "event_intro";
    case "PARENT_MESSAGE":
      if (state.phase === "sidebar") {
        return state.sidebarActive === action.sender;
      }
      return (
        state.phase === "family_chat" && state.parentMessageCount < PARENT_MESSAGE_CAP
      );
    case "KID_MESSAGE":
      return (
        state.phase === "family_chat" ||
        state.phase === "sidebar" ||
        state.phase === "adult_chat"
      );
    case "START_SIDEBAR":
      return (
        state.phase === "family_chat" &&
        state.sidebarActive === null &&
        !state.sidebarUsed[action.parent as "parent1" | "parent2"]
      );
    case "END_SIDEBAR":
      return state.phase === "sidebar";
    case "END_FAMILY_CHAT":
      return state.phase === "family_chat";
    case "IDENTITY_UPDATED":
      return state.phase === "processing";
    case "END_DEBRIEF":
      return state.phase === "debrief";
    case "START_EPILOGUE":
      return state.phase === "event_intro" || state.phase === "debrief";
    case "START_ADULT_CHAT":
      return state.phase === "epilogue" || state.phase === "event_intro";
    case "SHOW_REPORT_CARD":
      return state.phase === "event_intro" || state.phase === "epilogue";
    case "TRAJECTORY_CHECKED":
      return state.phase === "debrief";
    case "CONCERN_ACCRUED":
      // Not phase-gated: accrual is applied at scene end regardless of phase.
      return true;
    default:
      return false;
  }
}

export function transition(state: GameState, action: GameAction): GameState {
  if (!canTransition(state, action)) {
    throw new Error(`Invalid transition: ${action.type} from phase ${state.phase}`);
  }
  return { ...applyTransition(state, action), lastActivityAt: Date.now() };
}

function applyTransition(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "LOAD_EVENT":
      return {
        ...state,
        currentEvent: action.event,
        currentEventNumber: state.currentEventNumber + 1,
        events: [...state.events, action.event],
        pendingGuidance: null,
      };

    case "BEGIN_FAMILY_CHAT":
      return {
        ...state,
        phase: "family_chat",
      };

    case "START_EVENT":
      return {
        ...state,
        phase: "family_chat",
        currentEvent: action.event,
        currentEventNumber: state.currentEventNumber + 1,
        events: [...state.events, action.event],
        pendingGuidance: null,
      };

    case "PARENT_MESSAGE": {
      const chatType = state.phase === "sidebar" ? ("private" as const) : ("shared" as const);
      const visibleTo: Sender[] =
        chatType === "private" ? [action.sender, "kid"] : ["parent1", "parent2", "kid"];
      const message: Message = {
        sender: action.sender,
        content: action.content,
        chatType,
        visibleTo,
        timestamp: Date.now(),
        eventNumber: state.currentEventNumber,
      };
      return {
        ...state,
        messages: [...state.messages, message],
        parentMessageCount: state.parentMessageCount + 1,
      };
    }

    case "KID_MESSAGE": {
      const kidChatType =
        state.phase === "sidebar" ? ("private" as const) : ("shared" as const);
      const kidVisibleTo: Sender[] =
        state.phase === "sidebar" && state.sidebarActive
          ? [state.sidebarActive, "kid"]
          : ["parent1", "parent2", "kid"];
      const kidMessage: Message = {
        sender: "kid",
        content: action.content,
        chatType: kidChatType,
        visibleTo: kidVisibleTo,
        timestamp: Date.now(),
        eventNumber: state.currentEventNumber,
      };
      return {
        ...state,
        messages: [...state.messages, kidMessage],
      };
    }

    case "START_SIDEBAR":
      return {
        ...state,
        phase: "sidebar",
        sidebarActive: action.parent,
        sidebarUsed: {
          ...state.sidebarUsed,
          [action.parent]: true,
        },
      };

    case "END_SIDEBAR":
      return {
        ...state,
        phase: "family_chat",
        sidebarActive: null,
      };

    case "END_FAMILY_CHAT":
      return {
        ...state,
        phase: "processing",
      };

    case "IDENTITY_UPDATED":
      return {
        ...state,
        phase: "debrief",
        identityDocument: action.document,
        memorySummary: action.memorySummary ?? state.memorySummary,
        identitySnapshots: [
          ...state.identitySnapshots,
          {
            eventNumber: state.currentEventNumber,
            document: action.document,
          },
        ],
      };

    case "END_DEBRIEF":
      return {
        ...state,
        phase: "event_intro",
        currentEvent: null,
        parentMessageCount: 0,
        sidebarUsed: { parent1: false, parent2: false },
        sidebarActive: null,
      };

    case "START_EPILOGUE":
      return {
        ...state,
        phase: "epilogue",
      };

    case "START_ADULT_CHAT":
      return {
        ...state,
        phase: "adult_chat",
        currentEvent: action.event,
        parentMessageCount: 0,
      };

    case "SHOW_REPORT_CARD":
      return {
        ...state,
        phase: "report_card",
      };

    case "TRAJECTORY_CHECKED": {
      if (!action.concerning) {
        return { ...state, concerningStreak: 0 };
      }
      const streak = state.concerningStreak + 1;
      if (streak >= CONCERNING_STREAK_THRESHOLD) {
        return { ...state, concerningStreak: 0, pendingGuidance: action.guidanceSeed };
      }
      return { ...state, concerningStreak: streak };
    }

    case "CONCERN_ACCRUED": {
      const raw = state.concernLevel + action.delta;
      const clamped = Math.max(0, Math.min(CONCERN_MAX, raw));
      return { ...state, concernLevel: clamped };
    }

    default:
      return state;
  }
}

