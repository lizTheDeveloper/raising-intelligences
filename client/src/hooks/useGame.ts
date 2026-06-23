import { useState, useCallback } from "react";
import { track } from "../analytics";

export interface SavedKid {
  gameId: string;
  childName: string;
  createdAt: number;
}

const STORAGE_KEY = "raising-intelligences-kids";

export function getSavedKids(): SavedKid[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveKid(gameId: string, childName: string) {
  const kids = getSavedKids().filter((k) => k.gameId !== gameId);
  kids.unshift({ gameId, childName, createdAt: Date.now() });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(kids));
}

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

export async function syncKidsToServer(userId: string): Promise<void> {
  const kids = getSavedKids();
  if (!kids.length) return;
  await fetch(`${API}/user/${encodeURIComponent(userId)}/kids`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(kids.map((k) => ({ gameId: k.gameId, childName: k.childName }))),
  }).catch(() => {});
}

export async function fetchServerKids(userId: string): Promise<SavedKid[]> {
  try {
    const res = await fetch(`${API}/user/${encodeURIComponent(userId)}/kids`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export function mergeKids(local: SavedKid[], remote: SavedKid[]): SavedKid[] {
  const map = new Map<string, SavedKid>();
  for (const k of [...remote, ...local]) map.set(k.gameId, k);
  const merged = [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

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

  const setTrackedError = useCallback((msg: string | null, step?: string) => {
    if (msg) track("error_occurred", { step: step ?? "unknown" });
    setError(msg);
  }, []);

  const loadGame = useCallback(
    async (id: string) => {
      const res = await fetch(`${API}/game/${id}/state`);
      if (!res.ok) return false;
      const data = await res.json();
      setGameId(data.id);
      setChildName(data.childName);
      setPhase(data.phase);
      setCurrentEvent(data.currentEvent ?? null);
      setMessages(data.messages ?? []);
      setMessagesRemaining(12 - (data.parentMessageCount ?? 0));
      return true;
    },
    []
  );

  const createGame = useCallback(
    async (name: string, relationshipType = "solo parent") => {
      const res = await fetch(`${API}/game`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childName: name, relationshipType }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setTrackedError(`Failed to create game: ${res.status}${body ? ` — ${body}` : ""}`, "create_game");
        return;
      }
      const data = await res.json();
      setGameId(data.gameId);
      setChildName(name);
      setPhase("event_intro");
      saveKid(data.gameId, name);
      track("game_started", { relationshipType });
      const url = new URL(window.location.href);
      url.searchParams.set("game", data.gameId);
      url.searchParams.set("mode", relationshipType === "solo parent" ? "solo" : "multi");
      window.history.replaceState({}, "", url.toString());
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
      setTrackedError(`Failed to load next event: ${res.status}${body ? ` — ${body}` : ""}`, "next_event");
      return;
    }
    const data = await res.json();
    setCurrentEvent(data.event);
    setPhase("event_intro");
    setMessages([]);
    setMessagesRemaining(12);
    if (data.event) {
      track("event_intro_viewed", { age: data.event.age, eventNumber: data.event.eventNumber });
    }
  }, [gameId]);

  const beginChat = useCallback(() => {
    setPhase("family_chat");
    if (gameId) {
      fetch(`${API}/game/${gameId}/portraits/next`, { method: "POST" }).catch(() => {});
    }
    track("conversation_started", { age: currentEvent?.age ?? 0 });
  }, [gameId, currentEvent]);

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

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const res = await fetch(`${API}/game/${gameId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: "parent1", content }),
        });

        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => "");
          setTrackedError(`Message failed: ${res.status}${body ? ` — ${body}` : ""}`, "send_message");
          return;
        }

        reader = res.body.getReader();
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
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(line.slice(6));
            } catch {
              // Partial or malformed SSE line — skip and continue
              continue;
            }
            if (data.type === "chunk") {
              kidMessage += data.text as string;
              setStreamingMessage(kidMessage);
            } else if (data.type === "done") {
              setMessages((prev) => [
                ...prev,
                { sender: "kid", content: data.kidResponse as string, chatType: "shared" },
              ]);
              setStreamingMessage("");
              setMessagesRemaining(data.messagesRemaining as number);
            } else if (data.type === "error") {
              throw new Error((data.error as string) ?? "Stream error");
            }
          }
        }
      } catch (err) {
        setTrackedError(`Message failed: ${err instanceof Error ? err.message : String(err)}`, "send_message");
      } finally {
        reader?.cancel().catch(() => {});
        setIsStreaming(false);
        setStreamingMessage("");
      }
    },
    [gameId, isStreaming]
  );

  const endChat = useCallback(async () => {
    if (!gameId) return;
    const messagesSent = 12 - messagesRemaining;
    track("conversation_ended", {
      age: currentEvent?.age ?? 0,
      messagesSent,
      hitCap: messagesRemaining === 0,
    });
    setPhase("processing");
    setStreamingDocText("");
    setError(null);
    try {
      const res = await fetch(`${API}/game/${gameId}/end-chat`, { method: "POST" });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        setTrackedError(`Failed to end chat: ${res.status}${body ? ` — ${body}` : ""}`, "end_chat");
        setPhase("family_chat");
        setStreamingDocText("");
        return;
      }
      // Psychologist output is internal — fragments show on processing screen instead.
      const data = await consumeSSE<{ phase: string }>(res, () => {});
      setPhase(data.phase);
    } catch (err) {
      setTrackedError(`Failed to end chat: ${err instanceof Error ? err.message : String(err)}`, "end_chat");
      setPhase("family_chat");
      setStreamingDocText("");
    }
  }, [gameId, messagesRemaining, currentEvent]);

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
        setTrackedError(`Failed to generate epilogue: ${res.status}${body ? ` — ${body}` : ""}`, "epilogue");
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
      track("epilogue_reached");
    } catch (err) {
      setTrackedError(`Failed to generate epilogue: ${err instanceof Error ? err.message : String(err)}`, "epilogue");
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
        setTrackedError(`Failed to generate report card: ${res.status}${body ? ` — ${body}` : ""}`, "report_card");
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
      track("game_completed");
    } catch (err) {
      setTrackedError(`Failed to generate report card: ${err instanceof Error ? err.message : String(err)}`, "report_card");
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
    loadGame,
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
