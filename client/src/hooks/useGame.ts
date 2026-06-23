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
    setError(null);
    const res = await fetch(`${API}/game/${gameId}/next-event`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? "Failed to load next event");
      return;
    }
    const data = await res.json();
    setCurrentEvent(data.event);
    // Stay on event_intro so the player can read the description before chatting.
    // The server has already transitioned to family_chat and is ready to accept messages.
    setPhase("event_intro");
    setMessages([]);
    setMessagesRemaining(12);
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

      const res = await fetch(`${API}/game/${gameId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "parent1", content }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let kidMessage = "";
      // Buffer incomplete SSE lines across TCP packet boundaries so JSON.parse
      // never sees a partial data line.
      let lineBuffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          // Keep the last (potentially incomplete) fragment in the buffer.
          lineBuffer = lines.pop() ?? "";

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
              } else if (data.type === "error") {
                setError(data.error ?? "An error occurred");
              }
            } catch {
              // Malformed JSON on this line — skip it, don't crash the loop.
            }
          }
        }
      } finally {
        // Always release the lock, even if JSON.parse or the network threw.
        setIsStreaming(false);
      }
    },
    [gameId, isStreaming]
  );

  const endChat = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    setError(null);
    const res = await fetch(`${API}/game/${gameId}/end-chat`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? "Failed to process conversation");
      // Roll back to family_chat so the player isn't stuck on a blank screen.
      setPhase("family_chat");
      return;
    }
    const data = await res.json();
    setPhase(data.phase);
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
    setError(null);
    const res = await fetch(`${API}/game/${gameId}/epilogue`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? "Failed to generate epilogue");
      // Roll back to debrief so the player can retry.
      setPhase("debrief");
      return;
    }
    const data = await res.json();
    setEpilogue(data.epilogue);
    setPhase(data.phase);
  }, [gameId]);

  const generateReportCard = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    setError(null);
    const res = await fetch(`${API}/game/${gameId}/report-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epilogue }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError((body as { error?: string }).error ?? "Failed to generate report card");
      setPhase("epilogue");
      return;
    }
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
