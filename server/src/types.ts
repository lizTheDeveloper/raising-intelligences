export type GamePhase =
  | "lobby"
  | "event_intro"
  | "family_chat"
  | "sidebar"
  | "processing"
  | "debrief"
  | "consult"
  | "therapy"
  | "cps_review"
  | "epilogue"
  | "adult_chat"
  | "report_card"
  | "ended";

export type ChatType = "shared" | "private" | "debrief";

export type Sender = "parent1" | "parent2" | "kid";

export interface Message {
  sender: Sender;
  content: string;
  chatType: ChatType;
  visibleTo: Sender[];
  timestamp: number;
  /** Which game event this message belongs to (set at creation time). */
  eventNumber: number;
}

export interface TherapyMessage { speaker: "therapist" | "parent"; content: string }

export interface GameEvent {
  eventNumber: number;
  age: number;
  description: string;
  setting: string;
  trigger: string;
}

export interface ParentPersonality {
  ocean: [number, number, number, number, number]; // [O, C, E, A, N], each 1-4
  confessional1: string;
  confessional2: string;
}

export type ChildGender = "boy" | "girl" | "nonbinary";

export interface GameState {
  id: string;
  phase: GamePhase;
  childName: string;
  childGender: ChildGender;
  relationshipType: string;
  personalitySeed: string;
  parentPersonalities: {
    parent1?: ParentPersonality;
    parent2?: ParentPersonality;
  };
  currentEvent: GameEvent | null;
  currentEventNumber: number;
  totalEvents: number;
  identityDocument: string;
  identitySnapshots: { eventNumber: number; document: string }[];
  memorySummary: string;
  events: GameEvent[];
  messages: Message[];
  parentMessageCount: number;
  sidebarUsed: { parent1: boolean; parent2: boolean };
  sidebarActive: Sender | null;
  /** Consecutive scenes the trajectory check (safety/pattern-detection.ts)
   * has rated "notable"/"significant" — resets to 0 on a clean scene. Only
   * once this crosses a threshold does the pattern queue guidance for the
   * World Manager, so a single ambiguous scene doesn't trigger anything. */
  concerningStreak: number;
  /** Bounded [0, CONCERN_MAX] accumulator of net dark-parenting concern across
   * scenes (Dark Play Plan 2). Rises on a scene-end Tier A "concern" verdict,
   * decays on a clean scene; persisted. Server-only — never sent to clients;
   * the drift is surfaced later (report card / epilogue), never in-scene. */
  concernLevel: number;
  /** Dark Play Plan 3 — highest intervention rung that has fired (0 none, 1
   * consult, 2 therapy, 3 cps). Persisted; gates the ladder so each rung fires
   * at most once and reaching the next requires new dark play. Server-only. */
  highestRungFired: number;
  /** The generated read-and-advance text on screen (psychologist consult or CPS
   * determination). Ephemeral — regenerated per beat, not persisted. Null
   * outside consult/cps_review. */
  interventionText: string | null;
  /** Rung-2 family-therapy session transcript. Persisted so a mid-session
   * reconnect resumes; cleared on END_INTERVENTION. Empty outside therapy. */
  therapyMessages: TherapyMessage[];
  /** Last CPS determination, if Rung 3 has run. "removal" routes the game to a
   * terminal removal epilogue. Persisted (drives the epilogue branch). */
  cpsOutcome: "stay" | "safety_plan" | "removal" | null;
  /**
   * The generated epilogue narrative, once `START_EPILOGUE` has run. Empty
   * before that.
   *
   * Server-owned on purpose. It used to exist only in the closure of the
   * handler that generated it and in whatever client happened to catch the
   * one-shot `EPILOGUE` event — so the report card, which is built FROM the
   * epilogue, took the client's copy on trust. Any client that joined,
   * reloaded, or took the game over on another device after that event fired
   * held `""` and could generate a report card from nothing. Keeping it in
   * state means every STATE broadcast carries it and the server never has to
   * ask.
   *
   * NOT persisted (there is no column for it, and `saveEndgame` only writes one
   * at report-card time), so a game evicted from memory and rehydrated through
   * `repo.loadGame` comes back with `""`. That pre-existing durability gap is
   * why the socket handler still falls back to the client's value when state
   * has none.
   */
  epilogue: string;
  /** Queued for the next World Manager call: weave a supportive side
   * character into the next scene giving genuinely good, actionable advice
   * relevant to this (never naming or diagnosing the pattern). Cleared once
   * the next event is generated, whether or not it was used. */
  pendingGuidance: string | null;
  /** Unix ms of the last state transition; used for TTL eviction. */
  lastActivityAt: number;
}
