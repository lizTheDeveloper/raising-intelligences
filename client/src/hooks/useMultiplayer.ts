import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

// Mirror of server/src/socket/protocol.ts (kept in sync by convention).
const E = {
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
  JOINED: "joined",
  LOBBY: "lobby",
  STATE: "state",
  KID_CHUNK: "kid_chunk",
  MESSAGE_DONE: "message_done",
  DOC_CHUNK: "doc_chunk",
  DOC_DONE: "doc_done",
  EPILOGUE: "epilogue",
  REPORT_CARD_READY: "report_card_ready",
  ERROR: "error",
} as const;

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
  chatType: string;
}
export interface PublicPlayer {
  slot: Slot;
  displayName: string;
  ready: boolean;
  connected: boolean;
}
interface ViewerState {
  phase: string;
  childName: string;
  relationshipType: string;
  currentEvent: GameEvent | null;
  currentEventNumber: number;
  totalEvents: number;
  messages: Message[];
  messagesRemaining: number;
  sidebarActive: Slot | null;
  sidebarUsed: { parent1: boolean; parent2: boolean };
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

  const ensureSocket = useCallback((): Socket => {
    if (socketRef.current) return socketRef.current;
    const socketPath = import.meta.env.PROD ? "/raising-intelligences/socket.io" : "/socket.io";
    const socket = io({ autoConnect: true, path: socketPath });
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on(E.JOINED, (d: { gameId: string; slot: Slot }) => {
      setGameId(d.gameId);
      setSlot(d.slot);
      setInLobby(true);
    });
    socket.on(E.LOBBY, (d: { players: PublicPlayer[] }) => setPlayers(d.players));
    socket.on(E.STATE, (s: ViewerState) => {
      setState(s);
      if (s.phase !== "event_intro") setInLobby(false);
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
    socket.on(E.ERROR, (d: { error: string }) => setError(d.error));
    socketRef.current = socket;
    return socket;
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const createGame = useCallback(
    (childName: string, relationshipType: string, displayName: string) => {
      ensureSocket().emit(E.CREATE_GAME, { childName, relationshipType, displayName });
    },
    [ensureSocket]
  );

  const joinGame = useCallback(
    (id: string, displayName: string) => {
      ensureSocket().emit(E.JOIN_GAME, { gameId: id, displayName });
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

  return {
    connected,
    gameId,
    slot,
    players,
    state,
    inLobby,
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
    startSidebar,
    endSidebar,
    endChat,
    startEpilogue,
    startAdultChat,
    generateReportCard,
  };
}
