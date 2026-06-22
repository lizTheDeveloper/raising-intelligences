import { useState, useCallback } from "react";

interface GameEvent {
  eventNumber: number;
  age: number;
  description: string;
  setting: string;
  trigger: string;
}

interface Message {
  sender: string;
  content: string;
  chatType: string;
}

const API = "/api";

export function useGame() {
  const [gameId, setGameId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("start");
  const [childName, setChildName] = useState("");
  const [currentEvent, setCurrentEvent] = useState<GameEvent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesRemaining, setMessagesRemaining] = useState(12);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [epilogue, setEpilogue] = useState("");
  const [reportCard, setReportCard] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createGame = useCallback(
    async (name: string, relationshipType = "co-parents") => {
      const res = await fetch(`${API}/game`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childName: name, relationshipType }),
      });
      const data = await res.json();
      setGameId(data.gameId);
      setChildName(name);
      setPhase("event_intro");
      return data.gameId;
    },
    []
  );

  const nextEvent = useCallback(async () => {
    if (!gameId) return;
    const res = await fetch(`${API}/game/${gameId}/next-event`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? "Failed to load the next event. Please try again.");
      return;
    }
    const data = await res.json();
    setCurrentEvent(data.event);
    // Stay on event_intro so the player can read the description before chatting.
    // The server has already transitioned to family_chat and is ready to accept messages.
    setPhase("event_intro");
    setMessages([]);
    setMessagesRemaining(12);
    setError(null);
  }, [gameId]);

  const beginChat = useCallback(() => {
    setPhase("family_chat");
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!gameId || isStreaming) return;

      setMessages((prev) => [
        ...prev,
        { sender: "parent1", content, chatType: "shared" },
      ]);
      setIsStreaming(true);
      setStreamingMessage("");

      try {
        const res = await fetch(`${API}/game/${gameId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: "parent1", content }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? "Failed to send message.");
          return;
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let kidMessage = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Buffer chunks so SSE lines split across TCP packets are reassembled
          // before parsing, preventing SyntaxError on partial JSON.
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "chunk") {
                kidMessage += data.text;
                setStreamingMessage(kidMessage);
              } else if (data.type === "done") {
                setMessages((prev) => [
                  ...prev,
                  { sender: "kid", content: data.kidResponse, chatType: "shared" },
                ]);
                setStreamingMessage("");
                setMessagesRemaining(data.messagesRemaining);
              }
            } catch {
              // partial or malformed SSE line — skip
            }
          }
        }
      } finally {
        // Always unblock the input, even if the stream errored mid-flight.
        setIsStreaming(false);
      }
    },
    [gameId, isStreaming]
  );

  const endChat = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    const res = await fetch(`${API}/game/${gameId}/end-chat`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? "Something went wrong ending the conversation. Please try again.");
      setPhase("family_chat");
      return;
    }
    const data = await res.json();
    setPhase(data.phase);
    setError(null);
  }, [gameId]);

  const endDebrief = useCallback(async () => {
    if (!gameId) return;
    const res = await fetch(`${API}/game/${gameId}/end-debrief`, {
      method: "POST",
    });
    const data = await res.json();
    setPhase(data.phase);
    setCurrentEvent(null);
  }, [gameId]);

  const generateEpilogue = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    const res = await fetch(`${API}/game/${gameId}/epilogue`, { method: "POST" });
    const data = await res.json();
    setEpilogue(data.epilogue);
    setPhase(data.phase);
  }, [gameId]);

  const generateReportCard = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    const res = await fetch(`${API}/game/${gameId}/report-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epilogue }),
    });
    const data = await res.json();
    setReportCard(data.reportCard);
    setPhase(data.phase);
  }, [gameId, epilogue]);

  return {
    gameId,
    phase,
    childName,
    currentEvent,
    messages,
    messagesRemaining,
    streamingMessage,
    isStreaming,
    epilogue,
    reportCard,
    error,
    createGame,
    nextEvent,
    beginChat,
    sendMessage,
    endChat,
    endDebrief,
    generateEpilogue,
    generateReportCard,
  };
}
