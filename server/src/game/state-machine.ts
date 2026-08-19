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
  | { type: "CONCERN_ACCRUED"; delta: number }
  | { type: "ENTER_INTERVENTION"; rung: 1 | 2 | 3; text: string }
  | { type: "APPEND_THERAPY_MESSAGE"; speaker: "therapist" | "parent"; content: string }
  | { type: "SET_CPS_OUTCOME"; outcome: "stay" | "safety_plan" | "removal" }
  | { type: "END_INTERVENTION" };

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

/** Dark Play Plan 3 — intervention ladder thresholds on concernLevel (of CONCERN_MAX). */
export const CONSULT_THRESHOLD = 3;
export const THERAPY_THRESHOLD = 6;
export const CPS_THRESHOLD = 9;
/** Concern decayed when a parent completes each rung (engagement = reasonable efforts working). */
export const CONSULT_DECAY = 2;
export const THERAPY_DECAY = 3;
export const CPS_STAY_DECAY = 4;
/** Max parent messages in a Rung-2 therapy session before it must be concluded. */
export const THERAPY_TURN_CAP = 3;

/** The highest intervention rung whose threshold concernLevel has crossed and
 * whose number exceeds the highest already fired. 0 = none due. */
export function selectDueRung(concernLevel: number, highestRungFired: number): 0 | 1 | 2 | 3 {
  let due: 0 | 1 | 2 | 3 = 0;
  if (concernLevel >= CONSULT_THRESHOLD) due = 1;
  if (concernLevel >= THERAPY_THRESHOLD) due = 2;
  if (concernLevel >= CPS_THRESHOLD) due = 3;
  return due > highestRungFired ? due : 0;
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
    highestRungFired: 0,
    interventionText: null,
    therapyMessages: [],
    cpsOutcome: null,
    epilogue: "",
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
      // Debrief chat: "later that night, the kids are asleep, it's just you
      // two." Deliberately NOT subject to PARENT_MESSAGE_CAP — that cap is the
      // per-scene family-chat budget, and a debrief message must never eat a
      // parent's turns with their child. See the PARENT_MESSAGE reducer for
      // the chatType/visibleTo stamping that keeps the kid out of it.
      if (state.phase === "debrief") return true;
      // `adult_chat` is the endgame conversation with the grown child. It is a
      // scene like any other — START_ADULT_CHAT advances currentEventNumber and
      // resets parentMessageCount to 0 — so it gets the same per-scene budget.
      // The cap also bounds it as an LLM endpoint. Moderation for the phase is
      // NARROWED (categoriesForPhase in safety/moderation.ts), never skipped.
      return (
        (state.phase === "family_chat" || state.phase === "adult_chat") &&
        state.parentMessageCount < PARENT_MESSAGE_CAP
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
      // All three intervention rungs are valid places to end the story, not
      // just cps_review. The "end childhood → epilogue" button lives on the
      // Debrief screen, but a Dark Play rung can move the phase to consult or
      // therapy first — so the POST lands against an intervention phase and
      // used to throw "Invalid transition: START_EPILOGUE from phase consult",
      // handing the player an error instead of the ending of their story.
      // Seen in production 2026-08-03 15:43:37Z, two minutes after that game
      // accrued a concern and a rung fired.
      //
      // This does not skip the intervention's purpose: the concern is already
      // recorded and the consult/therapy text already generated by the time
      // this can fire. A parent who has chosen to end childhood should always
      // be able to reach their epilogue.
      return (
        state.phase === "event_intro" ||
        state.phase === "debrief" ||
        state.phase === "consult" ||
        state.phase === "therapy" ||
        state.phase === "cps_review"
      );
    case "ENTER_INTERVENTION":
      return state.phase === "debrief";
    case "APPEND_THERAPY_MESSAGE":
      return state.phase === "therapy";
    case "SET_CPS_OUTCOME":
      return state.phase === "cps_review";
    case "END_INTERVENTION":
      return state.phase === "consult" || state.phase === "therapy" || state.phase === "cps_review";
    case "START_ADULT_CHAT":
      return state.phase === "epilogue" || state.phase === "event_intro";
    case "SHOW_REPORT_CARD":
      // `adult_chat` is the phase the report card is meant to follow: its only
      // exit control is "finish → report card" (multiplayer) / Chat's
      // onEndChat={generateReportCard} (solo). Both threw "Invalid transition"
      // here, which is what made that button dead on a live-looking screen.
      return (
        state.phase === "event_intro" ||
        state.phase === "epilogue" ||
        state.phase === "adult_chat"
      );
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
      // The debrief is the one room in the game where the two humans talk to
      // each other with nothing generating between them: the kid is asleep, so
      // the message is stamped `debrief` and made invisible to "kid" (which
      // keeps it out of buildKidContext / buildSceneTranscript / the identity
      // document — all of which go through currentEventMessages(), which
      // already admits only "shared" | "private"). It also must not consume the
      // per-scene parent-message budget.
      const isDebrief = state.phase === "debrief";
      const chatType = isDebrief
        ? ("debrief" as const)
        : state.phase === "sidebar"
        ? ("private" as const)
        : ("shared" as const);
      const visibleTo: Sender[] = isDebrief
        ? ["parent1", "parent2"]
        : chatType === "private"
        ? [action.sender, "kid"]
        : ["parent1", "parent2", "kid"];
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
        parentMessageCount: isDebrief
          ? state.parentMessageCount
          : state.parentMessageCount + 1,
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
      // The text is kept, not just the phase. The report card is generated
      // from the epilogue, and the only other copy used to be whichever
      // client caught the one-shot EPILOGUE event — see GameState.epilogue.
      // START_ADULT_CHAT spreads `...state`, so it survives into `adult_chat`
      // and the report card generated from that phase gets it too.
      return {
        ...state,
        phase: "epilogue",
        epilogue: action.epilogue,
      };

    case "START_ADULT_CHAT":
      // Advances currentEventNumber and appends to `events` exactly like
      // START_EVENT, because the adult conversation IS another scene.
      //
      // It previously swapped `currentEvent` while leaving the number pinned to
      // the final childhood scene, so PARENT_MESSAGE stamped adult-chat
      // messages with that scene's eventNumber. Anything keyed on the number
      // then conflated the two: the per-scene transcript filter would render
      // the last childhood conversation above the adult one (playtest item 4),
      // currentEventMessages() fed the childhood transcript into the adult
      // kid-context, and reconstructState's parentMessageCount counted both.
      return {
        ...state,
        phase: "adult_chat",
        currentEvent: action.event,
        currentEventNumber: state.currentEventNumber + 1,
        events: [...state.events, action.event],
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

    case "ENTER_INTERVENTION": {
      const highestRungFired = Math.max(state.highestRungFired, action.rung);
      if (action.rung === 2) {
        // Therapy: the text is the therapist's opening turn; seed the session.
        return {
          ...state,
          phase: "therapy",
          interventionText: null,
          therapyMessages: [{ speaker: "therapist", content: action.text }],
          highestRungFired,
        };
      }
      return {
        ...state,
        phase: action.rung === 1 ? "consult" : "cps_review",
        interventionText: action.text,
        highestRungFired,
      };
    }
    case "APPEND_THERAPY_MESSAGE":
      return {
        ...state,
        therapyMessages: [...state.therapyMessages, { speaker: action.speaker, content: action.content }],
      };
    case "SET_CPS_OUTCOME":
      return { ...state, cpsOutcome: action.outcome };
    case "END_INTERVENTION":
      return {
        ...state,
        phase: "event_intro",
        interventionText: null,
        therapyMessages: [],
        currentEvent: null,
        parentMessageCount: 0,
        sidebarUsed: { parent1: false, parent2: false },
        sidebarActive: null,
      };

    default:
      return state;
  }
}

