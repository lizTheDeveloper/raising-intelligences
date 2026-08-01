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
  const playerTokenRef = useRef<string | null>(null);
  /** Our own slot, readable from inside the socket listeners (which are
   * registered once and never see later renders' state). */
  const slotRef = useRef<Slot | null>(null);
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
      setSlot(d.slot);
      slotRef.current = d.slot;
      setInLobby(true);
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
    setSlot(null);
    slotRef.current = null;
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
    streamingMessage,
    streamingDocText,
    isStreaming,
    epilogue,
    reportCard,
    error,
    createGame,
    joinGame,
    ready,
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
