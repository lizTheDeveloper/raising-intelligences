import type { GamePhase, GameEvent, Message, Sender } from "../types.js";
import type { PlayerSlot } from "../game/session-manager.js";

/**
 * The socket.io event contract shared (by convention) between server and
 * client. The client mirrors these payload shapes in its own hook.
 */

// ---- Client → Server ----
export interface CreateGamePayload {
  childName: string;
  relationshipType?: string;
  displayName?: string;
}
export interface JoinGamePayload {
  gameId: string;
  displayName?: string;
  playerToken?: string;
}
export interface ReadyPayload {
  ready: boolean;
}
export interface ParentMessagePayload {
  content: string;
}
export interface AdultChatPayload {
  scenario: string;
}

// ---- Server → Client ----
export interface PublicPlayer {
  slot: PlayerSlot;
  displayName: string;
  ready: boolean;
  connected: boolean;
}

export interface LobbyState {
  gameId: string;
  players: PublicPlayer[];
}

/** Game state as seen by a specific player — identity doc stripped, messages
 * filtered to those visible to that player's slot. */
export interface ViewerState {
  id: string;
  phase: GamePhase;
  childName: string;
  relationshipType: string;
  currentEvent: GameEvent | null;
  currentEventNumber: number;
  totalEvents: number;
  messages: Message[];
  parentMessageCount: number;
  messagesRemaining: number;
  sidebarActive: Sender | null;
  sidebarUsed: { parent1: boolean; parent2: boolean };
}

export const SOCKET_EVENTS = {
  // client → server
  CREATE_GAME: "create_game",
  JOIN_GAME: "join_game",
  READY: "ready",
  PARENT_MESSAGE: "parent_message",
  START_SIDEBAR: "start_sidebar",
  END_SIDEBAR: "end_sidebar",
  END_CHAT: "end_chat",
  START_EPILOGUE: "start_epilogue",
  ADULT_CHAT: "adult_chat",
  REPORT_CARD: "report_card",
  // server → client
  JOINED: "joined",
  LOBBY: "lobby",
  STATE: "state",
  KID_CHUNK: "kid_chunk",
  MESSAGE_DONE: "message_done",
  /** Generic doc chunk — streamed Psychologist / Epilogue / Report Card text. */
  DOC_CHUNK: "doc_chunk",
  /** Final event after a doc stream completes (psychologist done). */
  DOC_DONE: "doc_done",
  EPILOGUE: "epilogue",
  REPORT_CARD_READY: "report_card_ready",
  ERROR: "error",
} as const;
