import type { ChildGender, GamePhase, GameEvent, Message, Sender, TherapyMessage } from "../types.js";
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
  /** Matrix user id of the creating player, when signed in. Server-side only —
   * never echoed back in lobby/public player views. */
  userId?: string;
}
export interface JoinGamePayload {
  gameId: string;
  displayName?: string;
  playerToken?: string;
  /** Matrix user id of the joining player, when signed in. */
  userId?: string;
  /**
   * A single-use device-handoff code (see REQUEST_HANDOFF). Redeeming it binds
   * this socket to the slot the code was minted for and issues the normal
   * `playerToken` in the JOINED reply — the same credential a first join gets.
   *
   * Deliberately NOT the playerToken itself. The token is a long-lived bearer
   * credential for a game that holds the players' confessed traumas; a link
   * carrying it, pasted into a chat app or captured by a proxy log, would hand
   * over the session permanently. This code is bound to {gameId, slot}, expires
   * in minutes, and is burned on first use.
   */
  handoffCode?: string;
}
export interface ReadyPayload {
  ready: boolean;
}
export interface ParentMessagePayload {
  content: string;
}
export interface TherapyMessagePayload {
  content: string;
}
export interface AdultChatPayload {
  scenario: string;
}
export interface PersonalityPayload {
  ocean: [number, number, number, number, number];
  confessional1?: string;
  confessional2?: string;
}
/** Client → server co-presence ping. Fire-and-forget: no persistence, no
 * state-machine involvement, no lock. Ignored when the socket is not in a game. */
export interface TypingPayload {
  typing: boolean;
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
  childGender: ChildGender;
  relationshipType: string;
  currentEvent: GameEvent | null;
  currentEventNumber: number;
  totalEvents: number;
  messages: Message[];
  parentMessageCount: number;
  messagesRemaining: number;
  sidebarActive: Sender | null;
  sidebarUsed: { parent1: boolean; parent2: boolean };
  /** Dark Play Plan 3 — the human-facing beat text (psychologist consult /
   * CPS determination). The whole point of the consult/cps_review screens;
   * server-only fields that drive it (concernLevel, highestRungFired,
   * cpsOutcome) stay out of ViewerState. Null outside consult/cps_review. */
  interventionText: string | null;
  /** Rung-2 family-therapy session transcript, for the therapy screen. */
  therapyMessages: TherapyMessage[];
  /**
   * Whether the server is currently generating the next scenario for this game.
   * Derived from server-owned in-flight state on EVERY viewerState() call, so
   * every STATE broadcast self-corrects it — including the reconnect/join paths,
   * which emit STATE but no GENERATING event.
   *
   * This is the source of truth. `E.GENERATING` still fires around the call for
   * latency (the client may use it as a fast-path hint), but it is a
   * fire-and-forget event: a client that misses the `false` edge (reconnect,
   * backgrounded tab, dropped frame) used to display "building the next
   * scene…" forever over a perfectly correct scene. See playtest note 7.
   */
  generating: boolean;
  /**
   * Has the OTHER parent finished the guardian quiz?
   *
   * Slot-specific, like the rest of this payload, and derived from
   * `parentPersonalities` on every viewerState() call — so it is correct on
   * reconnect and on a fresh join, neither of which replays the one-shot
   * PERSONALITY_SUBMITTED event. Same reasoning as `generating`: anything the
   * server owns rides on STATE rather than living as client-local state that
   * quietly drifts (see playtest note 7).
   *
   * It exists so the guardian screen's waiting step can name the wait it is
   * actually covering. Between submitting your own answers and the co-parent
   * submitting theirs, nothing is being generated at all — the seed call has
   * not started, and saying otherwise is the one progress message in the
   * opening that isn't true.
   */
  partnerPersonalitySubmitted: boolean;
  /**
   * The epilogue narrative, or "" before it has been generated.
   *
   * Carried on every STATE for the same reason as the two fields above: the
   * one-shot `E.EPILOGUE` event is not replayed on reconnect, join, or device
   * handoff, so a client that arrived after it fired held "" — and the
   * epilogue screen's "continue" sends that value up as the basis for the
   * report card. Server-owned means a client never has to have been present
   * for the epilogue to ask for a report card about it.
   */
  epilogue: string;
}

/** Server → room co-presence broadcast, emitted to the *other* player only. */
export interface TypingBroadcast {
  slot: Sender;
  typing: boolean;
}

/**
 * Server → the requesting socket only. The freshly minted device-handoff code
 * and how long it has to live.
 *
 * `code` is a 128-bit random value, url-safe encoded. It is never logged, never
 * broadcast to the room, and never persisted; it exists only in the issuing
 * process's memory until it is redeemed or expires.
 */
export interface HandoffCodePayload {
  code: string;
  /** Wall-clock expiry (ms since epoch), so the UI can say how long is left. */
  expiresAt: number;
}

/**
 * Server → the socket that was holding a slot when another live socket claimed
 * it. Purely informational: the superseded socket keeps its room membership and
 * keeps receiving STATE (see slotRoom — a second socket for a player is a
 * supported, tested state), so it is never frozen mid-scene. What it can no
 * longer do is ready up, because ready is keyed on the slot's current
 * connection — which is exactly why the client must say so out loud rather than
 * leave a dead button on screen.
 */
export interface SupersededPayload {
  slot: PlayerSlot;
}

export const SOCKET_EVENTS = {
  // client → server
  CREATE_GAME: "create_game",
  JOIN_GAME: "join_game",
  READY: "ready",
  PARENT_MESSAGE: "parent_message",
  /** Dark Play Plan 3 — a parent's turn during a Rung-2 therapy session.
   * Distinct from PARENT_MESSAGE (guarded to family_chat) so the two flows
   * stay unambiguous. */
  THERAPY_MESSAGE: "therapy_message",
  /** Co-presence signal. Client → server `{ typing }`; the server re-broadcasts
   * `{ slot, typing }` under the same name to the OTHER player only. Purely
   * ephemeral: no persistence, no state-machine involvement, no game lock. */
  TYPING: "typing",
  START_SIDEBAR: "start_sidebar",
  END_SIDEBAR: "end_sidebar",
  END_CHAT: "end_chat",
  START_EPILOGUE: "start_epilogue",
  ADULT_CHAT: "adult_chat",
  REPORT_CARD: "report_card",
  SUBMIT_PERSONALITY: "submit_personality",
  /**
   * "I want to continue this on another device." Mints a short-lived,
   * single-use code bound to the requesting socket's {gameId, slot}, answered
   * with HANDOFF_CODE to that socket alone.
   *
   * Socket-only by design, with no REST twin: the socket is already
   * authenticated to a slot (`socket.data`), whereas an HTTP endpoint would
   * have nothing to authenticate with. `gameId` travels in the invite link, so
   * a `POST /api/game/:id/handoff` would let anyone holding that link mint a
   * credential for a slot they don't own.
   */
  REQUEST_HANDOFF: "request_handoff",
  // server → client
  JOINED: "joined",
  /** The minted handoff code — to the requesting socket only, never the room. */
  HANDOFF_CODE: "handoff_code",
  /** Another live socket has taken over this slot. See SupersededPayload. */
  SUPERSEDED: "superseded",
  LOBBY: "lobby",
  STATE: "state",
  KID_CHUNK: "kid_chunk",
  MESSAGE_DONE: "message_done",
  /** Server is generating the next scenario. Emitted `true` before the (long)
   * world-manager call and `false` once it settles, so the ready flags being
   * cleared reads as progress rather than as the click having been undone. */
  GENERATING: "generating",
  /** Generic doc chunk — streamed Psychologist / Epilogue / Report Card text. */
  DOC_CHUNK: "doc_chunk",
  /** Final event after a doc stream completes (psychologist done). */
  DOC_DONE: "doc_done",
  EPILOGUE: "epilogue",
  REPORT_CARD_READY: "report_card_ready",
  SCENE_ENDED: "scene_ended",
  ERROR: "error",
  PERSONALITY_SUBMITTED: "personality_submitted",
  PERSONALITY_SEED_READY: "personality_seed_ready",
} as const;
