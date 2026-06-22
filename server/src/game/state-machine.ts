import type { GameState, GameEvent, Message, Sender } from "../types.js";
import { randomUUID } from "crypto";

const PARENT_MESSAGE_CAP = 12;

export type GameAction =
  | { type: "LOAD_EVENT"; event: GameEvent }
  | { type: "BEGIN_FAMILY_CHAT" }
  | { type: "START_EVENT"; event: GameEvent }
  | { type: "PARENT_MESSAGE"; sender: Sender; content: string }
  | { type: "KID_MESSAGE"; content: string }
  | { type: "START_SIDEBAR"; parent: Sender }
  | { type: "END_SIDEBAR" }
  | { type: "END_FAMILY_CHAT" }
  | { type: "IDENTITY_UPDATED"; document: string }
  | { type: "READY_UP"; player: Sender }
  | { type: "END_DEBRIEF" }
  | { type: "START_EPILOGUE"; epilogue: string }
  | { type: "START_ADULT_CHAT"; event: GameEvent }
  | { type: "SHOW_REPORT_CARD"; reportCard: string };

export function createGame(childName: string, relationshipType = "co-parents"): GameState {
  return {
    id: randomUUID(),
    phase: "event_intro",
    childName,
    relationshipType,
    currentEvent: null,
    currentEventNumber: 0,
    totalEvents: 10,
    identityDocument: "",
    identitySnapshots: [],
    events: [],
    messages: [],
    parentMessageCount: 0,
    sidebarUsed: { parent1: false, parent2: false },
    sidebarActive: null,
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
    default:
      return false;
  }
}

export function transition(state: GameState, action: GameAction): GameState {
  if (!canTransition(state, action)) {
    throw new Error(`Invalid transition: ${action.type} from phase ${state.phase}`);
  }

  switch (action.type) {
    case "LOAD_EVENT":
      return {
        ...state,
        currentEvent: action.event,
        currentEventNumber: state.currentEventNumber + 1,
        events: [...state.events, action.event],
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

    default:
      return state;
  }
}
