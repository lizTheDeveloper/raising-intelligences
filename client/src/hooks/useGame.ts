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

const API = import.meta.env.BASE_URL + "api";

/**
 * Consume an SSE response that streams `chunk` events then a `done` event.
 * Returns the final `done` payload once the stream closes.
 */
async function consumeSSE<T>(
  res: Response,
  onChunk: (text: string) => void
): Promise<T> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let donePayload: T | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuffer += decoder.decode(value, { stream: true });
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "chunk") {
          onChunk(data.text);
        } else if (data.type === "done") {
          donePayload = data as T;
        } else if (data.type === "error") {
          throw new Error(data.error ?? "Stream error");
        }
      } catch {
        // Partial or malformed SSE line — skip
      }
    }
  }

  if (!donePayload) throw new Error("Stream ended without done event");
  return donePayload;
}

export function useGame() {
  const [gameId, setGameId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("start");
  const [childName, setChildName] = useState("");
  const [currentEvent, setCurrentEvent] = useState<GameEvent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesRemaining, setMessagesRemaining] = useState(12);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [streamingDocText, setStreamingDocText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [epilogue, setEpilogue] = useState("");
  const [reportCard, setReportCard] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createGame = useCallback(
    async (name: string, relationshipType = "solo parent") => {
      const res = await fetch(`${API}/game`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childName: name, relationshipType }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setError(`Failed to create game: ${res.status}${body ? ` — ${body}` : ""}`);
        return;
      }
      const data = await res.json();
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
    setError(null);
    const res = await fetch(`${API}/game/${gid}/next-event`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      setError(`Failed to load next event: ${res.status}${body ? ` — ${body}` : ""}`);
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
    if (gameId) {
      fetch(`${API}/game/${gameId}/portraits/next`, { method: "POST" }).catch(() => {});
    }
  }, [gameId]);

  // Fix for #20: buffer partial SSE lines across network reads and guard
  // JSON.parse with try/catch so a mid-packet TCP split can never lock the UI.
  const sendMessage = useCallback(
    async (content: string) => {
      if (!gameId || isStreaming) return;

      setMessages((prev) => [
        ...prev,
        { sender: "parent1", content, chatType: "shared" },
      ]);
      setIsStreaming(true);
      setStreamingMessage("");
      setError(null);

      try {
        const res = await fetch(`${API}/game/${gameId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: "parent1", content }),
        });

        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => "");
          setError(`Message failed: ${res.status}${body ? ` — ${body}` : ""}`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let kidMessage = "";
        let lineBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          // Keep the last (possibly incomplete) fragment in the buffer
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
              }
            } catch {
              // Partial or malformed SSE line — skip and continue
            }
          }
        }
      } finally {
        // Always clear streaming state, even if an error occurred mid-stream
        setIsStreaming(false);
        setStreamingMessage("");
      }
    },
    [gameId, isStreaming]
  );

  const endChat = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    setStreamingDocText("");
    setError(null);
    try {
      const res = await fetch(`${API}/game/${gameId}/end-chat`, { method: "POST" });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        setError(`Failed to end chat: ${res.status}${body ? ` — ${body}` : ""}`);
        setPhase("family_chat");
        setStreamingDocText("");
        return;
      }
      let docText = "";
      const data = await consumeSSE<{ phase: string }>(res, (text) => {
        docText += text;
        setStreamingDocText(docText);
      });
      setStreamingDocText("");
      setPhase(data.phase);
    } catch (err) {
      setError(`Failed to end chat: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("family_chat");
      setStreamingDocText("");
    }
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
    setStreamingDocText("");
    setError(null);
    try {
      const res = await fetch(`${API}/game/${gameId}/epilogue`, { method: "POST" });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        setError(`Failed to generate epilogue: ${res.status}${body ? ` — ${body}` : ""}`);
        setPhase("debrief");
        setStreamingDocText("");
        return;
      }
      let docText = "";
      const data = await consumeSSE<{ phase: string; epilogue: string }>(res, (text) => {
        docText += text;
        setStreamingDocText(docText);
      });
      setEpilogue(data.epilogue);
      setStreamingDocText("");
      setPhase(data.phase);
    } catch (err) {
      setError(`Failed to generate epilogue: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("debrief");
      setStreamingDocText("");
    }
  }, [gameId]);

  const generateReportCard = useCallback(async () => {
    if (!gameId) return;
    setPhase("processing");
    setStreamingDocText("");
    setError(null);
    try {
      const res = await fetch(`${API}/game/${gameId}/report-card`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epilogue }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        setError(`Failed to generate report card: ${res.status}${body ? ` — ${body}` : ""}`);
        setPhase("epilogue");
        setStreamingDocText("");
        return;
      }
      let docText = "";
      const data = await consumeSSE<{ phase: string; reportCard: string }>(res, (text) => {
        docText += text;
        setStreamingDocText(docText);
      });
      setReportCard(data.reportCard);
      setStreamingDocText("");
      setPhase(data.phase);
    } catch (err) {
      setError(`Failed to generate report card: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("epilogue");
      setStreamingDocText("");
    }
  }, [gameId, epilogue]);

  return {
    gameId,
    phase,
    childName,
    currentEvent,
    messages,
    messagesRemaining,
    streamingMessage,
    streamingDocText,
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
