import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { track } from "../analytics";

const E = {
  CREATE_GAME: "create_game",
  JOIN_GAME: "join_game",
  READY: "ready",
  PARENT_MESSAGE: "parent_message",
  /** Dark Play Plan 3, Rung 2 — a parent's turn during a family-therapy
   * session. Distinct from PARENT_MESSAGE (guarded to family_chat) so the
   * two flows stay unambiguous, mirroring the server's socket protocol. */
  THERAPY_MESSAGE: "therapy_message",
  START_SIDEBAR: "start_sidebar",
  END_SIDEBAR: "end_sidebar",
  END_CHAT: "end_chat",
  START_EPILOGUE: "start_epilogue",
  ADULT_CHAT: "adult_chat",
  REPORT_CARD: "report_card",
  SUBMIT_PERSONALITY: "submit_personality",
  PERSONALITY_SUBMITTED: "personality_submitted",
  PERSONALITY_SEED_READY: "personality_seed_ready",
  /** "let me keep playing from my phone" — see HANDOFF_CODE. */
  REQUEST_HANDOFF: "request_handoff",
  /** The minted single-use handoff code, to this socket only. */
  HANDOFF_CODE: "handoff_code",
  /** Another live socket took over our slot. */
  SUPERSEDED: "superseded",
  JOINED: "joined",
  LOBBY: "lobby",
  STATE: "state",
  KID_CHUNK: "kid_chunk",
  MESSAGE_DONE: "message_done",
  DOC_CHUNK: "doc_chunk",
  DOC_DONE: "doc_done",
  EPILOGUE: "epilogue",
  REPORT_CARD_READY: "report_card_ready",
  SCENE_ENDED: "scene_ended",
  GENERATING: "generating",
  /** Co-parent presence. client → server `{ typing: boolean }`; server →
   * the *other* player `{ slot, typing }`. Purely advisory — it never gates
   * anything, and (see PARTNER_TYPING_TTL) a dropped `typing: false` expires
   * on the receiving side rather than sticking forever. */
  TYPING: "typing",
  ERROR: "error",
} as const;

const RESUME_KEY = "ri_resume";

/**
 * How long a received `typing: true` survives without a refresh.
 *
 * Receiver-side expiry, not just sender-side debounce: the `generating` flag
 * (see below) taught us that any boolean set by one event and cleared by
 * another sticks forever the moment the clearing event is dropped — a
 * backgrounded tab, a reconnect, a partner who closed the window mid-word.
 * The sender re-emits `true` every TYPING_IDLE_MS-bounded burst, so a live
 * typist keeps re-arming this; a vanished one decays.
 */
const PARTNER_TYPING_TTL = 5000;

interface ResumeData {
  gameId: string;
  playerToken: string;
}

function loadResume(): ResumeData | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.gameId && data?.playerToken) return data as ResumeData;
    return null;
  } catch {
    return null;
  }
}

function saveResume(gameId: string, playerToken: string): void {
  localStorage.setItem(RESUME_KEY, JSON.stringify({ gameId, playerToken }));
}

export function clearResume(): void {
  localStorage.removeItem(RESUME_KEY);
}

/**
 * Build the "continue on another device" link for a minted handoff code.
 *
 * The code goes in the URL **fragment**, not the query string, and that is a
 * security decision rather than a cosmetic one. A query parameter is recorded
 * by every log sink between the player and the game: the reverse proxy's access
 * log, and Umami — which reports `pathname + search` on the automatic pageview
 * that fires before any of our code runs, so we could not strip it in time.
 * Sentry's `beforeSend` only drops `event.user`, so a client crash would carry
 * it too. A fragment is never sent to the server and is excluded from all
 * three. `?game=` stays in the query because the app already routes on it and
 * a game id is not a credential.
 *
 * The result is still a plain link you can text yourself:
 *   https://…/raising-intelligences/?game=<uuid>#handoff=<22 chars>
 */
export function buildHandoffUrl(gameId: string, code: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("game", gameId);
  // Not a resume link for this device: a stale mode=solo would misroute it.
  url.searchParams.delete("mode");
  url.hash = `handoff=${code}`;
  return url.toString();
}

/**
 * Pull a handoff code out of the current URL and erase it from the address bar
 * in the same breath, so it cannot be re-redeemed by a reload, screenshotted
 * from the omnibox, or carried into a shared-screen recording. (It is
 * single-use server-side regardless; this is about what is left lying around.)
 *
 * The query form is accepted as well as the fragment form — a code that reaches
 * us through a link-mangling chat client should still work, and it is the shape
 * the feature was originally specced with.
 */
export function takeHandoffCodeFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("handoff");
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const fromHash = new URLSearchParams(hash).get("handoff");
    const code = fromHash || fromQuery;
    if (!code) return null;
    url.searchParams.delete("handoff");
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
    return code;
  } catch {
    return null;
  }
}

export type Slot = "parent1" | "parent2";

export interface GameEvent {
  eventNumber: number;
  age: number;
  description: string;
  setting: string;
  trigger: string;
}
export interface Message {
  sender: string;
  content: string;
  /** "shared" (family chat) | "private" (sidebar) | "debrief" (the two
   * parents alone, after the kid is asleep). */
  chatType: string;
  /** Which game event this message belongs to, stamped server-side at
   * creation (`server/src/types.ts`'s `Message.eventNumber`). The server has
   * always sent it inside ViewerState.messages; this type just never
   * declared it, which is why nothing filtered the transcript per scene. */
  eventNumber: number;
}
export interface PublicPlayer {
  slot: Slot;
  displayName: string;
  ready: boolean;
  connected: boolean;
}
/** Dark Play Plan 3 — mirrors server/src/types.ts's TherapyMessage and
 * client/src/hooks/useGame.ts's local copy. No shared package between
 * client and server (or between the solo/multiplayer hooks), so this is
 * kept structurally in sync by hand like the rest of this file's types. */
export interface TherapyMessage {
  speaker: "therapist" | "parent";
  content: string;
}
interface ViewerState {
  phase: string;
  childName: string;
  childGender?: "boy" | "girl" | "nonbinary";
  relationshipType: string;
  currentEvent: GameEvent | null;
  currentEventNumber: number;
  totalEvents: number;
  messages: Message[];
  messagesRemaining: number;
  sidebarActive: Slot | null;
  sidebarUsed: { parent1: boolean; parent2: boolean };
  /** Dark Play Plan 3 — the human-facing consult/CPS beat text. Null outside
   * the consult/cps_review phases. */
  interventionText: string | null;
  /** Dark Play Plan 3, Rung 2 — the family-therapy session transcript. Empty
   * outside the therapy phase. */
  therapyMessages: TherapyMessage[];
  /**
   * True while the server is building the next scenario.
   *
   * Optional on purpose. This is the authoritative copy — every STATE
   * broadcast carries it, so a client that missed a `GENERATING` event (or
   * reconnected mid-generation) self-corrects on the next broadcast. The
   * `E.GENERATING` event is kept as a low-latency hint. Declared optional
   * rather than required because a server that hasn't shipped the field yet
   * would otherwise read as a hard `false` on every broadcast and stomp the
   * hint; the STATE listener only honours it when it is actually a boolean.
   */
  generating?: boolean;
}

export function useMultiplayer() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [gameId, setGameId] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [players, setPlayers] = useState<PublicPlayer[]>([]);
  const [state, setState] = useState<ViewerState | null>(null);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [streamingDocText, setStreamingDocText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [epilogue, setEpilogue] = useState("");
  const [reportCard, setReportCard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [inLobby, setInLobby] = useState(false);
  const [seedReady, setSeedReady] = useState(false);
  const [sceneEnding, setSceneEnding] = useState(false);
  /** True while the server is generating the next scenario. Lets the UI show
   * progress instead of the ready flags appearing to reset for no reason.
   * Mirrors `ViewerState.generating` — the STATE broadcast is authoritative
   * and the GENERATING event is only a head start. */
  const [generating, setGenerating] = useState(false);
  /** The *other* parent is composing a message. Advisory only. */
  const [partnerTyping, setPartnerTyping] = useState(false);
  /** A live "continue on another device" link, once the server has minted one. */
  const [handoff, setHandoff] = useState<{ url: string; expiresAt: number } | null>(null);
  /**
   * Another device is playing this slot now. STATE keeps arriving (the server
   * never evicts us), so the view stays current — but ready is keyed on the
   * slot's live connection, so this device cannot advance the game. The UI has
   * to say that out loud; a silently dead ready button is the exact failure the
   * last round of work removed.
   */
  const [superseded, setSuperseded] = useState(false);
  const playerTokenRef = useRef<string | null>(null);
  /**
   * Suppresses the automatic rejoin-on-connect while superseded.
   *
   * In memory, NOT localStorage. Clearing the stored credential here would be
   * wrong twice over: localStorage is shared between tabs, so a second tab
   * taking over would race its own `saveResume` and could strand a live game
   * with no way back; and a reload of this tab *should* rejoin (coming back to
   * your laptop and refreshing is a legitimate way to take the game back — it
   * just supersedes the phone, which gets its own notice).
   */
  const supersededRef = useRef(false);
  /** A handoff code waiting for the socket to finish connecting. */
  const pendingHandoffRef = useRef<{ gameId: string; code: string } | null>(null);
  /** Our own slot, readable from inside the socket listeners (which are
   * registered once and never see later renders' state). */
  const slotRef = useRef<Slot | null>(null);
  /** Same reason as slotRef: the HANDOFF_CODE listener needs the game id. */
  const gameIdRef = useRef<string | null>(null);
  const partnerTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<string | null>(null);

  const clearPartnerTyping = useCallback(() => {
    if (partnerTypingTimer.current) {
      clearTimeout(partnerTypingTimer.current);
      partnerTypingTimer.current = null;
    }
    setPartnerTyping(false);
  }, []);

  const ensureSocket = useCallback((): Socket => {
    if (socketRef.current) return socketRef.current;
    const socketPath = import.meta.env.PROD ? "/raising-intelligences/socket.io" : "/socket.io";
    const socket = io({ autoConnect: true, path: socketPath });

    socket.on("connect", () => {
      setConnected(true);
      // A handoff code outranks stored resume data. This device may well hold
      // a credential for a *different* game (or the other slot of this one);
      // the link the player just followed is the more recent intent, and the
      // code is single-use, so it has to be spent on this connection.
      const pending = pendingHandoffRef.current;
      if (pending) {
        pendingHandoffRef.current = null;
        socket.emit(E.JOIN_GAME, { gameId: pending.gameId, handoffCode: pending.code });
        return;
      }
      // Don't crawl back into a game another device has taken over. Purely a
      // local decision — the credential is untouched, so a reload still can.
      if (supersededRef.current) return;
      // Auto-rejoin on reconnect if we have resume data
      const resume = loadResume();
      if (resume) {
        socket.emit(E.JOIN_GAME, {
          gameId: resume.gameId,
          playerToken: resume.playerToken,
        });
      }
    });

    socket.on("disconnect", () => setConnected(false));

    socket.on(E.JOINED, (d: { gameId: string; slot: Slot; playerToken?: string }) => {
      setGameId(d.gameId);
      gameIdRef.current = d.gameId;
      setSlot(d.slot);
      slotRef.current = d.slot;
      setInLobby(true);
      // We hold the slot again (fresh join, resume, or a handoff redeemed on
      // this device). Any takeover notice is stale, and a previously minted
      // link is no longer the one we'd want to show.
      supersededRef.current = false;
      setSuperseded(false);
      setHandoff(null);
      track("player_joined", { game_id: d.gameId });
      if (d.playerToken) {
        playerTokenRef.current = d.playerToken;
        saveResume(d.gameId, d.playerToken);
      }
      // Reflect the gameId in the URL so the link is durable: a reload returns
      // to this game, and the host can copy the address bar to invite a partner.
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get("game") !== d.gameId) {
          url.searchParams.set("game", d.gameId);
          window.history.replaceState(null, "", url.toString());
        }
      } catch {
        /* non-fatal: URL update is best-effort */
      }
    });

    socket.on(E.LOBBY, (d: { players: PublicPlayer[] }) => {
      setPlayers(d.players);
      // A partner who dropped mid-sentence is not still typing.
      if (d.players.some((p) => p.slot !== slotRef.current && !p.connected)) {
        clearPartnerTyping();
      }
    });
    socket.on(E.STATE, (s: ViewerState) => {
      setState(s);
      if (s.phase !== "event_intro") setInLobby(false);
      if (s.phase !== "family_chat" && s.phase !== "sidebar") setSceneEnding(false);
      // STATE is the source of truth for `generating`: honouring it on every
      // broadcast is what makes a missed/duplicated GENERATING event, a
      // backgrounded tab, or a reconnect self-correct instead of stranding
      // the client on "building the next scene…" forever. Guarded on the
      // type so a server build that predates the field leaves the
      // event-driven value alone rather than clearing it from `undefined`.
      if (typeof s.generating === "boolean") setGenerating(s.generating);
      if (s.phase !== phaseRef.current) {
        phaseRef.current = s.phase;
        clearPartnerTyping();
      }
    });
    socket.on(E.SCENE_ENDED, () => setSceneEnding(true));
    socket.on(E.GENERATING, (d: { generating: boolean }) => setGenerating(!!d.generating));
    socket.on(E.TYPING, (d: { slot: Slot; typing: boolean }) => {
      // The server addresses this to the other player, but ignore any echo of
      // our own slot defensively — we never want to show ourselves typing.
      if (d.slot === slotRef.current) return;
      if (partnerTypingTimer.current) {
        clearTimeout(partnerTypingTimer.current);
        partnerTypingTimer.current = null;
      }
      if (!d.typing) {
        setPartnerTyping(false);
        return;
      }
      setPartnerTyping(true);
      partnerTypingTimer.current = setTimeout(() => {
        partnerTypingTimer.current = null;
        setPartnerTyping(false);
      }, PARTNER_TYPING_TTL);
    });
    socket.on(E.KID_CHUNK, (d: { text: string }) => {
      setIsStreaming(true);
      setStreamingMessage((prev) => prev + d.text);
    });
    socket.on(E.MESSAGE_DONE, () => {
      setStreamingMessage("");
      setIsStreaming(false);
    });
    socket.on(E.DOC_CHUNK, (d: { text: string }) => {
      setStreamingDocText((prev) => prev + d.text);
    });
    socket.on(E.DOC_DONE, () => {
      setStreamingDocText("");
    });
    socket.on(E.EPILOGUE, (d: { epilogue: string }) => {
      setStreamingDocText("");
      setEpilogue(d.epilogue);
    });
    socket.on(E.REPORT_CARD_READY, (d: { reportCard: string }) => {
      setStreamingDocText("");
      setReportCard(d.reportCard);
    });
    socket.on(E.PERSONALITY_SUBMITTED, () => {
      // Other parent submitted — informational only
    });
    socket.on(E.PERSONALITY_SEED_READY, () => {
      setSeedReady(true);
    });
    socket.on(E.HANDOFF_CODE, (d: { code: string; expiresAt: number }) => {
      // The code lives exactly as long as the panel showing it: built into a
      // URL for display and never stored, tracked, or sent anywhere else.
      setHandoff({ url: buildHandoffUrl(gameIdRef.current ?? "", d.code), expiresAt: d.expiresAt });
    });
    socket.on(E.SUPERSEDED, () => {
      supersededRef.current = true;
      setSuperseded(true);
      // A link minted here would hand over a slot this device no longer drives.
      setHandoff(null);
      clearPartnerTyping();
    });
    socket.on(E.ERROR, (d: { error: string }) => setError(d.error));
    socketRef.current = socket;
    return socket;
  }, [clearPartnerTyping]);

  useEffect(() => {
    return () => {
      if (partnerTypingTimer.current) clearTimeout(partnerTypingTimer.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const createGame = useCallback(
    (childName: string, relationshipType: string, displayName: string) => {
      const userId = window.matrixAuth?.getUserId() ?? undefined;
      ensureSocket().emit(E.CREATE_GAME, { childName, relationshipType, displayName, userId });
    },
    [ensureSocket]
  );

  const joinGame = useCallback(
    (id: string, displayName: string) => {
      const userId = window.matrixAuth?.getUserId() ?? undefined;
      ensureSocket().emit(E.JOIN_GAME, { gameId: id, displayName, userId });
    },
    [ensureSocket]
  );

  const ready = useCallback((value: boolean) => {
    socketRef.current?.emit(E.READY, { ready: value });
  }, []);

  /** Ask the server for a fresh "continue on another device" link. */
  const requestHandoff = useCallback(() => {
    setHandoff(null);
    socketRef.current?.emit(E.REQUEST_HANDOFF);
  }, []);

  /** Drop the displayed link without redeeming it. The code stays live until it
   * expires or is used — the server has no revoke, and adding one would mean a
   * second code-shaped message on the wire for no real gain. */
  const dismissHandoff = useCallback(() => setHandoff(null), []);

  /**
   * Redeem a handoff code from a link. Routed through a ref + the connect
   * handler rather than a bare emit so it works identically whether the socket
   * is already up (a link opened in a live tab) or still dialling (the normal
   * cold open on a second device).
   */
  const redeemHandoff = useCallback(
    (id: string, code: string) => {
      pendingHandoffRef.current = { gameId: id, code };
      const socket = ensureSocket();
      if (socket.connected) {
        pendingHandoffRef.current = null;
        socket.emit(E.JOIN_GAME, { gameId: id, handoffCode: code });
      }
    },
    [ensureSocket]
  );

  /**
   * Take the game back on this device after being superseded. Uses the
   * credential this device already holds — no code round-trip — and in turn
   * supersedes whichever device is currently playing, which gets the same
   * notice this one just showed. The handoff is symmetric in both directions.
   */
  const reclaimHere = useCallback(() => {
    const resume = loadResume();
    const id = gameIdRef.current ?? resume?.gameId;
    const token = playerTokenRef.current ?? resume?.playerToken;
    if (!id || !token) return;
    supersededRef.current = false;
    setSuperseded(false);
    ensureSocket().emit(E.JOIN_GAME, { gameId: id, playerToken: token });
  }, [ensureSocket]);

  const sendMessage = useCallback((content: string) => {
    if (!content.trim()) return;
    setIsStreaming(true);
    setStreamingMessage("");
    socketRef.current?.emit(E.PARENT_MESSAGE, { content: content.trim() });
  }, []);

  /**
   * A message in the debrief conversation — the two parents, after the kid is
   * asleep. Same PARENT_MESSAGE event, deliberately NOT `sendMessage`: that
   * one arms `isStreaming` for a kid reply that is never coming here.
   *
   * The server does close the round trip with MESSAGE_DONE, so `sendMessage`
   * would happen to work today — but it would make the debrief input depend on
   * a clearing event to un-stick a flag it had no reason to set, which is the
   * exact shape of the `generating` bug. There is nothing to wait for in the
   * debrief, so nothing is latched.
   */
  const sendDebriefMessage = useCallback((content: string) => {
    if (!content.trim()) return;
    socketRef.current?.emit(E.PARENT_MESSAGE, { content: content.trim() });
  }, []);

  /** Tell the co-parent we are (or have stopped) composing. Fire-and-forget:
   * a lost emit costs a presence dot, never correctness. */
  const setTyping = useCallback((typing: boolean) => {
    socketRef.current?.emit(E.TYPING, { typing });
  }, []);

  // Dark Play Plan 3, Rung 2 — a parent's turn during a therapy session. No
  // local streaming/loading flags are set here (unlike sendMessage): the
  // server streams the therapist's reply via the existing DOC_CHUNK event
  // and then rebroadcasts STATE with the appended therapyMessages, so the
  // transcript updates through the normal state flow rather than an
  // optimistic local append.
  const sendTherapyMessage = useCallback((content: string) => {
    if (!content.trim()) return;
    socketRef.current?.emit(E.THERAPY_MESSAGE, { content: content.trim() });
  }, []);

  const startSidebar = useCallback(() => socketRef.current?.emit(E.START_SIDEBAR), []);
  const endSidebar = useCallback(() => socketRef.current?.emit(E.END_SIDEBAR), []);
  const endChat = useCallback(() => {
    setStreamingDocText("");
    socketRef.current?.emit(E.END_CHAT);
  }, []);
  const startEpilogue = useCallback(() => {
    setStreamingDocText("");
    socketRef.current?.emit(E.START_EPILOGUE);
  }, []);
  const startAdultChat = useCallback(
    (scenario: string) => socketRef.current?.emit(E.ADULT_CHAT, { scenario }),
    []
  );
  const generateReportCard = useCallback(() => {
    setStreamingDocText("");
    socketRef.current?.emit(E.REPORT_CARD, { epilogue });
  }, [epilogue]);

  const submitPersonality = useCallback((payload: { ocean: number[]; confessional1?: string; confessional2?: string }) => {
    socketRef.current?.emit(E.SUBMIT_PERSONALITY, payload);
  }, []);

  const leaveGame = useCallback(() => {
    clearResume();
    setGameId(null);
    gameIdRef.current = null;
    setSlot(null);
    slotRef.current = null;
    setHandoff(null);
    setSuperseded(false);
    supersededRef.current = false;
    pendingHandoffRef.current = null;
    setPlayers([]);
    setState(null);
    setInLobby(false);
    setError(null);
    clearPartnerTyping();
    phaseRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
  }, [clearPartnerTyping]);

  return {
    connected,
    gameId,
    slot,
    players,
    state,
    inLobby,
    seedReady,
    sceneEnding,
    generating,
    partnerTyping,
    handoff,
    superseded,
    streamingMessage,
    streamingDocText,
    isStreaming,
    epilogue,
    reportCard,
    error,
    createGame,
    joinGame,
    ready,
    requestHandoff,
    dismissHandoff,
    redeemHandoff,
    reclaimHere,
    sendMessage,
    sendDebriefMessage,
    sendTherapyMessage,
    setTyping,
    submitPersonality,
    startSidebar,
    endSidebar,
    endChat,
    startEpilogue,
    startAdultChat,
    generateReportCard,
    leaveGame,
    ensureSocket,
  };
}
