export type GamePhase =
  | "lobby"
  | "event_intro"
  | "family_chat"
  | "sidebar"
  | "processing"
  | "debrief"
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
  /** Unix ms of the last state transition; used for TTL eviction. */
  lastActivityAt: number;
}
