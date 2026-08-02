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

export function saveKid(gameId: string, childName: string) {
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
  /**
   * Which game event this message belongs to, stamped server-side at creation
   * (`server/src/types.ts`'s `Message.eventNumber`). The server has always sent
   * it; this type just never declared it, so callers filtering a transcript per
   * scene had to cast.
   *
   * Optional, and that is not laziness: `sendMessage` below appends the
   * player's own message optimistically with no event number and nothing ever
   * replaces it with the server's copy. An un-stamped message is one this
   * client created, in the current scene, just now.
   */
  eventNumber?: number;
}

export interface TherapyMessage {
  speaker: "therapist" | "parent";
  content: string;
}

// Mirrors server/src/game/state-machine.ts THERAPY_TURN_CAP. Not exposed by
// any REST/SSE response (server-only constant, no shared package between
// client and server) — hardcoded here and must be kept in sync by hand.
export const THERAPY_TURN_CAP = 3;

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
      let parsed: { type: string; text?: string; error?: string } | null = null;
      try {
        parsed = JSON.parse(line.slice(6));
      } catch {
        // Partial or malformed SSE line — skip
        continue;
      }
      if (parsed && parsed.type === "chunk") {
        onChunk(parsed.text ?? "");
      } else if (parsed && parsed.type === "done") {
        donePayload = parsed as unknown as T;
      } else if (parsed && parsed.type === "error") {
        throw new Error(parsed.error ?? "Stream error");
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
  const [childGender, setChildGender] = useState<"boy" | "girl" | "nonbinary">("nonbinary");
  const [currentEvent, setCurrentEvent] = useState<GameEvent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesRemaining, setMessagesRemaining] = useState(12);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [streamingDocText, setStreamingDocText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [interventionText, setInterventionText] = useState<string | null>(null);
  const [therapyMessages, setTherapyMessages] = useState<TherapyMessage[]>([]);
  const [epilogue, setEpilogue] = useState("");
  const [reportCard, setReportCard] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setTrackedError = useCallback((msg: string | null, step?: string) => {
    if (msg) {
      // Capture the message + any HTTP status alongside the step so failures are
      // diagnosable from analytics alone, without SSH-ing to server logs. The
      // client-built messages carry no user PII (status + generic server text).
      const statusMatch = msg.match(/\b([45]\d{2})\b/);
      track("error_occurred", {
        step: step ?? "unknown",
        message: msg.slice(0, 120),
        ...(statusMatch ? { status: Number(statusMatch[1]) } : {}),
      });
    }
    setError(msg);
  }, []);

  const loadGame = useCallback(
    async (id: string) => {
      const res = await fetch(`${API}/game/${id}/state`);
      if (!res.ok) return false;
      const data = await res.json();
      setGameId(data.id);
      setChildName(data.childName);
      setChildGender(data.childGender ?? "nonbinary");
      setPhase(data.phase);
      setCurrentEvent(data.currentEvent ?? null);
      setMessages(data.messages ?? []);
      setMessagesRemaining(data.messagesRemaining ?? 12 - (data.parentMessageCount ?? 0));
      setInterventionText(data.interventionText ?? null);
      setTherapyMessages(data.therapyMessages ?? []);
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

  // Defined ABOVE nextEvent on purpose: nextEvent auto-advances into the
  // epilogue at the end of the arc, so it names this callback in its own
  // dependency array. A `const` referenced in a dep array is evaluated at
  // render time — declaring this below nextEvent would throw
  // "Cannot access 'generateEpilogue' before initialization" on the first
  // render, which neither `tsc` nor the (nonexistent) client test runner
  // would catch.
  const generateEpilogue = useCallback(async (id?: string) => {
    const gid = id ?? gameId;
    if (!gid) return;
    setPhase("processing");
    setStreamingDocText("");
    setError(null);
    try {
      const res = await fetch(`${API}/game/${gid}/epilogue`, { method: "POST" });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        setTrackedError(`Failed to generate epilogue: ${res.status}${body ? ` — ${body}` : ""}`, "epilogue");
        setStreamingDocText("");
        // Reconcile with the server rather than assuming `debrief`, exactly as
        // endChat does below and for the same reason. This used to hardcode
        // setPhase("debrief"), which was survivable while the only caller was
        // the manual "end childhood" button on the debrief screen. It is not
        // survivable now: nextEvent auto-advances into the epilogue from
        // `event_intro`, so a failed call would have parked the client on a
        // Debrief screen whose "continue" POSTs /end-debrief, which 409s from
        // event_intro — a second brick behind a different door.
        if (!(await loadGame(gid))) setPhase("debrief");
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
      setStreamingDocText("");
      if (!(await loadGame(gid))) setPhase("debrief");
    }
  }, [gameId, loadGame, setTrackedError]);

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

    // End of the arc. The server refuses to author a scene past `totalEvents`
    // and says so with `storyComplete` (routes/game.ts /next-event) — this is
    // the client half of that contract, and the reason a solo game now ends on
    // its own instead of running until the world manager ages the child past
    // 30 and every call starts throwing.
    //
    // Handled HERE rather than in SoloGame because all six of SoloGame's
    // advance paths (opening seed, event-intro retry, debrief, and the three
    // Dark Play intervention continuations) funnel through this one function.
    // One check covers them all, and the comparison itself stays server-side
    // so there is no client-held copy of the arc length to drift.
    //
    // The manual "end childhood → epilogue" button on the debrief screen is a
    // separate, deliberate early exit and is untouched — it calls
    // generateEpilogue directly.
    //
    // Returns before the setState block below on purpose: falling through
    // would flash `event_intro` with a null event and fire a bogus
    // event_intro_viewed a beat before the epilogue sets `processing`.
    if (data.storyComplete) {
      await generateEpilogue(gid);
      return;
    }

    setCurrentEvent(data.event);
    setPhase("event_intro");
    setMessages([]);
    setMessagesRemaining(12);
    if (data.event) {
      track("event_intro_viewed", { age: data.event.age, eventNumber: data.event.eventNumber });
    }
  }, [gameId, generateEpilogue, setTrackedError]);

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
              // Unlock input immediately — the kid has responded and the user
              // can type again. The stream may not have physically closed yet
              // (finally will also clear this), but there's nothing left to receive.
              setIsStreaming(false);
            } else if (data.type === "terminated") {
              setPhase("ended");
              setTrackedError("This session has ended.", "moderation");
              setStreamingMessage("");
              setIsStreaming(false);
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
        setStreamingDocText("");
        // Reconcile with the server instead of assuming family_chat — end-chat
        // often succeeded server-side (the phase already advanced), and assuming
        // family_chat is what let users re-click into the "Invalid transition"
        // loop. Fall back to family_chat only if the state fetch also fails.
        if (!(await loadGame(gameId))) setPhase("family_chat");
        return;
      }
      // Psychologist output is internal — fragments show on processing screen instead.
      const data = await consumeSSE<{ phase: string }>(res, () => {});
      setPhase(data.phase);
    } catch (err) {
      setTrackedError(`Failed to end chat: ${err instanceof Error ? err.message : String(err)}`, "end_chat");
      setStreamingDocText("");
      if (!(await loadGame(gameId))) setPhase("family_chat");
    }
  }, [gameId, messagesRemaining, currentEvent, loadGame]);

  const endDebrief = useCallback(async () => {
    if (!gameId) return null;
    const res = await fetch(`${API}/game/${gameId}/end-debrief`, {
      method: "POST",
    });
    const data = await res.json();
    // Dark Play Plan 3 — end-debrief's response carries only `phase`; when a
    // due rung reroutes into consult/therapy/cps_review, the generated
    // interventionText / therapyMessages live on the game state, not this
    // response, so fetch /state (which sets phase itself, along with the
    // rest) instead of setting phase here directly — avoids a render with
    // phase=consult but interventionText still null/stale. Returns the
    // phase so the caller (SoloGame) can decide whether to advance to the
    // next event (only when no rung fired, i.e. phase is "event_intro") or
    // render the intervention screen instead.
    if (data.phase === "consult" || data.phase === "therapy" || data.phase === "cps_review") {
      await loadGame(gameId);
    } else {
      setPhase(data.phase);
      setCurrentEvent(null);
    }
    return data.phase as string;
  }, [gameId, loadGame]);

  // Dark Play Plan 3, Rung 1 — conclude a consult beat. Plain JSON (not SSE),
  // mirroring endDebrief. END_INTERVENTION on the server always routes back
  // to event_intro (consult never terminates the game), so there is no
  // branching on the returned phase here.
  const endConsult = useCallback(async () => {
    if (!gameId) return;
    setError(null);
    const res = await fetch(`${API}/game/${gameId}/end-consult`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      setTrackedError(`Failed to end consult: ${res.status}${body ? ` — ${body}` : ""}`, "end_consult");
      return;
    }
    const data = await res.json();
    setPhase(data.phase);
    setCurrentEvent(null);
    setInterventionText(null);
  }, [gameId, setTrackedError]);

  // Dark Play Plan 3, Rung 2 — a parent's turn during a therapy session.
  // SSE, mirroring sendMessage exactly: optimistic parent turn appended
  // immediately, therapist reply streamed chunk-by-chunk into
  // streamingDocText (shared with the other doc-generation flows — safe
  // since therapy can't overlap them), then folded into therapyMessages on
  // "done". "terminated" (moderation block) ends the session like /message.
  const sendTherapyMessage = useCallback(
    async (content: string) => {
      if (!gameId || isStreaming) return;

      setTherapyMessages((prev) => [...prev, { speaker: "parent", content }]);
      setIsStreaming(true);
      setStreamingDocText("");
      setError(null);

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const res = await fetch(`${API}/game/${gameId}/therapy-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });

        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => "");
          setTrackedError(`Message failed: ${res.status}${body ? ` — ${body}` : ""}`, "therapy_message");
          return;
        }

        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let therapistText = "";
        let lineBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if (data.type === "chunk") {
              therapistText += data.text as string;
              setStreamingDocText(therapistText);
            } else if (data.type === "done") {
              if (typeof data.therapistResponse === "string") {
                setTherapyMessages((prev) => [
                  ...prev,
                  { speaker: "therapist", content: data.therapistResponse as string },
                ]);
              }
              setPhase(data.phase as string);
              setStreamingDocText("");
              setIsStreaming(false);
            } else if (data.type === "terminated") {
              setPhase("ended");
              setTrackedError("This session has ended.", "moderation");
              setStreamingDocText("");
              setIsStreaming(false);
            } else if (data.type === "error") {
              throw new Error((data.error as string) ?? "Stream error");
            }
          }
        }
      } catch (err) {
        setTrackedError(`Message failed: ${err instanceof Error ? err.message : String(err)}`, "therapy_message");
      } finally {
        reader?.cancel().catch(() => {});
        setIsStreaming(false);
        setStreamingDocText("");
      }
    },
    [gameId, isStreaming, setTrackedError]
  );

  // Dark Play Plan 3, Rung 2 — conclude the therapy session. Plain JSON,
  // mirroring endConsult; always routes back to event_intro.
  const endTherapy = useCallback(async () => {
    if (!gameId) return;
    setError(null);
    const res = await fetch(`${API}/game/${gameId}/end-therapy`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      setTrackedError(`Failed to end therapy: ${res.status}${body ? ` — ${body}` : ""}`, "end_therapy");
      return;
    }
    const data = await res.json();
    setPhase(data.phase);
    setCurrentEvent(null);
    setTherapyMessages([]);
  }, [gameId, setTrackedError]);

  // Dark Play Plan 3, Rung 3 — conclude the CPS review. Plain JSON. Unlike
  // consult/therapy this CAN be terminal: a "removal" determination makes
  // the server generate the removal epilogue inline and return BOTH
  // phase: "epilogue" and the epilogue text in this same response — the
  // exact shape generateEpilogue's SSE "done" payload produces. Reuse the
  // existing epilogue state/display path rather than opening a second one;
  // returns the resulting phase so the caller can decide whether to render
  // Endgame (phase === "epilogue") or advance to the next event.
  const endCps = useCallback(async () => {
    if (!gameId) return null;
    setError(null);
    const res = await fetch(`${API}/game/${gameId}/end-cps`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      setTrackedError(`Failed to end CPS review: ${res.status}${body ? ` — ${body}` : ""}`, "end_cps");
      return null;
    }
    const data = (await res.json()) as { phase: string; epilogue?: string };
    if (typeof data.epilogue === "string") {
      setEpilogue(data.epilogue);
      track("epilogue_reached");
    }
    setPhase(data.phase);
    setCurrentEvent(null);
    setInterventionText(null);
    return data.phase;
  }, [gameId, setTrackedError]);

  const generateReportCard = useCallback(async (userId?: string) => {
    if (!gameId) return;
    setPhase("processing");
    setStreamingDocText("");
    setError(null);
    try {
      const qp = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      const res = await fetch(`${API}/game/${gameId}/report-card${qp}`, {
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
    childGender,
    currentEvent,
    messages,
    messagesRemaining,
    streamingMessage,
    streamingDocText,
    isStreaming,
    interventionText,
    therapyMessages,
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
    endConsult,
    sendTherapyMessage,
    endTherapy,
    endCps,
    generateEpilogue,
    generateReportCard,
  };
}
