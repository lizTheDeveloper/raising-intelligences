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

  const createGame = useCallback(
    async (name: string, relationshipType = "co-parents") => {
      const res = await fetch(`${API}/game`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childName: name, relationshipType }),
      });
      if (!res.ok) throw new Error("Failed to create game");
      const data = await res.json();
      const id: string = data.gameId;
      setGameId(id);
      setChildName(name);

      // Immediately fetch the first event so the player lands on event_intro
      // with content already loaded, avoiding the blank double-begin screen.
      const eventRes = await fetch(`${API}/game/${id}/next-event`, { method: "POST" });
      if (eventRes.ok) {
        const eventData = await eventRes.json();
        setCurrentEvent(eventData.event);
      }

      setPhase("event_intro");
      return id;
    },
    []
  );

  const nextEvent = useCallback(async () => {
    if (!gameId) return;
    const res = await fetch(`${API}/game/${gameId}/next-event`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error("[nextEvent] server returned", res.status);
      return;
    }
    const data = await res.json();
    setCurrentEvent(data.event);
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
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.type === "chunk") {
                  kidMessage += parsed.text;
                  setStreamingMessage(kidMessage);
                } else if (parsed.type === "done") {
                  setMessages((prev) => [
                    ...prev,
                    { sender: "kid", content: parsed.kidResponse, chatType: "shared" },
                  ]);
                  setStreamingMessage("");
                  setMessagesRemaining(parsed.messagesRemaining);
                }
              } catch {
                // ignore malformed SSE lines
              }
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
    const res = await fetch(`${API}/game/${gameId}/end-chat`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error("[endChat] server returned", res.status);
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
