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
      if (!res.ok) {
        setError(data.error ?? "Failed to create game");
        return null;
      }
      setGameId(data.gameId);
      setChildName(name);
      setPhase("event_intro");
      return data.gameId;
    },
    []
  );

  const nextEvent = useCallback(async (id?: string) => {
    const gid = id ?? gameId;
    if (!gid) return;
    const res = await fetch(`${API}/game/${gid}/next-event`, {
      method: "POST",
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to load next event");
      setPhase("error");
      return;
    }
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

      try {
        const res = await fetch(`${API}/game/${gameId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: "parent1", content }),
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let kidMessage = "";
        let lineBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          // Keep the last (possibly incomplete) line in the buffer
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
                setError(data.error ?? "Streaming error");
              }
            } catch {
              // Partial JSON on a split boundary — skip and continue
            }
          }
        }
      } finally {
        setIsStreaming(false);
      }
    },
    [gameId, isStreaming]
  );

  const endChat = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    try {
      const res = await fetch(`${API}/game/${gameId}/end-chat`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to end conversation");
        setPhase("family_chat");
        return;
      }
      setPhase(data.phase);
    } catch {
      setError("Network error ending conversation");
      setPhase("family_chat");
    }
  }, [gameId]);

  const endDebrief = useCallback(async () => {
    if (!gameId) return;
    try {
      const res = await fetch(`${API}/game/${gameId}/end-debrief`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to end debrief");
        return;
      }
      setPhase(data.phase);
      setCurrentEvent(null);
    } catch {
      setError("Network error ending debrief");
    }
  }, [gameId]);

  const generateEpilogue = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    try {
      const res = await fetch(`${API}/game/${gameId}/epilogue`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to generate epilogue");
        setPhase("debrief");
        return;
      }
      setEpilogue(data.epilogue);
      setPhase(data.phase);
    } catch {
      setError("Network error generating epilogue");
      setPhase("debrief");
    }
  }, [gameId]);

  const generateReportCard = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    try {
      const res = await fetch(`${API}/game/${gameId}/report-card`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epilogue }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to generate report card");
        setPhase("epilogue");
        return;
      }
      setReportCard(data.reportCard);
      setPhase(data.phase);
    } catch {
      setError("Network error generating report card");
      setPhase("epilogue");
    }
  }, [gameId, epilogue]);

  return {
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
