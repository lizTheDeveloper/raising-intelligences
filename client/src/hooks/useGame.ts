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
    const data = await res.json();
    setCurrentEvent(data.event);
    setPhase(data.phase);
    setMessages([]);
    setMessagesRemaining(12);
  }, [gameId]);

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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
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
          }
        }
      }
      setIsStreaming(false);
    },
    [gameId, isStreaming]
  );

  const endChat = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    const res = await fetch(`${API}/game/${gameId}/end-chat`, {
      method: "POST",
    });
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

  return {
    phase,
    childName,
    currentEvent,
    messages,
    messagesRemaining,
    streamingMessage,
    isStreaming,
    createGame,
    nextEvent,
    sendMessage,
    endChat,
    endDebrief,
  };
}
