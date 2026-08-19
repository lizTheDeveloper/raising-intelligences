import { useState, useCallback, useRef } from "react";
import { track, mark, secondsSince, bucketSeconds, bucketHours } from "../analytics";

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

  /**
   * How many scenes this session has actually seen, for the epilogue's
   * `scenesPlayed`. A ref rather than state: nothing renders off it, and it
   * must be readable from inside callbacks without re-creating them.
   *
   * Seeded by loadGame so a resumed game reports the arc's depth, not this
   * sitting's.
   */
  const scenesPlayedRef = useRef(0);

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

  /**
   * @param source Only the two genuine *resume* entry points pass this — the
   *   `?game=` deep link and the saved-kids picker. Everything else that calls
   *   loadGame is an error reconcile (a failed end-chat, a failed epilogue),
   *   and firing `game_resumed` from those would invent resumes that never
   *   happened. That is why the flag is a caller's argument and not something
   *   this function infers.
   */
  const loadGame = useCallback(
    async (id: string, source?: "url" | "saved_list") => {
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
      const restoredEventNumber = data.currentEvent?.eventNumber ?? data.currentEventNumber ?? 0;
      if (restoredEventNumber > scenesPlayedRef.current) {
        scenesPlayedRef.current = restoredEventNumber;
      }
      // A resume restores phase/age/eventNumber and, until now, emitted
      // nothing — which is why every funnel denominator in this title was
      // silently contaminated by games picked back up mid-arc.
      if (source && data.phase !== "start") {
        const saved = getSavedKids().find((k) => k.gameId === id);
        track("game_resumed", {
          source,
          phase: data.phase,
          eventNumber: restoredEventNumber,
          age: data.currentEvent?.age ?? 0,
          ...(saved
            ? { hoursSinceCreated: bucketHours((Date.now() - saved.createdAt) / 3_600_000) }
            : {}),
        });
      }
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
      scenesPlayedRef.current = 0;
      // `mode` is the new field to cross-tab on. `relationshipType` is kept
      // because existing reports read it, but it is NOT a mode split: this
      // function is the solo hook and always passes its own default, which is
      // why every row in 30d reads "solo parent".
      track("game_started", { relationshipType, mode: "solo" });
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
  /**
   * @param route WHY this ending is happening. Passed explicitly at both call
   *   sites (never defaulted at one of them) because the two mean completely
   *   different things and collapsing them is exactly the ambiguity that made
   *   "27 sessions reached an epilogue" unreadable against "10 sessions
   *   reached the last scene".
   */
  const generateEpilogue = useCallback(async (id?: string, route: "arc_complete" | "ended_early" = "ended_early") => {
    const gid = id ?? gameId;
    if (!gid) return;
    setPhase("processing");
    mark("processing");
    track("processing_started", {
      kind: "ending",
      eventNumber: currentEvent?.eventNumber ?? scenesPlayedRef.current,
      age: currentEvent?.age ?? 0,
    });
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
      track("epilogue_reached", {
        route,
        eventNumber: currentEvent?.eventNumber ?? scenesPlayedRef.current,
        age: currentEvent?.age ?? 0,
        scenesPlayed: scenesPlayedRef.current,
        mode: "solo",
      });
    } catch (err) {
      setTrackedError(`Failed to generate epilogue: ${err instanceof Error ? err.message : String(err)}`, "epilogue");
      setStreamingDocText("");
      if (!(await loadGame(gid))) setPhase("debrief");
    }
  }, [gameId, loadGame, setTrackedError, currentEvent]);

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
      await generateEpilogue(gid, "arc_complete");
      return;
    }

    setCurrentEvent(data.event);
    setPhase("event_intro");
    setMessages([]);
    setMessagesRemaining(12);
    if (data.event) {
      if (data.event.eventNumber > scenesPlayedRef.current) {
        scenesPlayedRef.current = data.event.eventNumber;
      }
      track("event_intro_viewed", { age: data.event.age, eventNumber: data.event.eventNumber, mode: "solo" });
    }
  }, [gameId, generateEpilogue, setTrackedError]);

  const beginChat = useCallback(() => {
    setPhase("family_chat");
    if (gameId) {
      fetch(`${API}/game/${gameId}/portraits/next`, { method: "POST" }).catch(() => {});
    }
    track("conversation_started", {
      age: currentEvent?.age ?? 0,
      eventNumber: currentEvent?.eventNumber ?? 0,
      mode: "solo",
    });
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
      eventNumber: currentEvent?.eventNumber ?? 0,
      messagesSent,
      hitCap: messagesRemaining === 0,
      mode: "solo",
    });
    setPhase("processing");
    // The gap the whole investigation is about: a median 67.6s of LLM
    // generation between here and the debrief, previously marked by nothing at
    // all — so an abandoned wait, a hung stream and a deliberate quit were the
    // same shape. `mark` is read by SoloGame's debrief_viewed.
    mark("processing");
    track("processing_started", {
      kind: "scene_debrief",
      eventNumber: currentEvent?.eventNumber ?? 0,
      age: currentEvent?.age ?? 0,
    });
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
    // Rung 1 never terminates the game — END_INTERVENTION always routes back to
    // event_intro — so the outcome is fixed rather than derived.
    track("intervention_completed", {
      rung: 1,
      outcome: "returned_to_story",
      turnsTaken: 0,
      eventNumber: currentEvent?.eventNumber ?? scenesPlayedRef.current,
      mode: "solo",
    });
    setPhase(data.phase);
    setCurrentEvent(null);
    setInterventionText(null);
  }, [gameId, setTrackedError, currentEvent]);

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
    track("intervention_completed", {
      rung: 2,
      outcome: "returned_to_story",
      turnsTaken: therapyMessages.filter((m) => m.speaker === "parent").length,
      eventNumber: currentEvent?.eventNumber ?? scenesPlayedRef.current,
      mode: "solo",
    });
    setPhase(data.phase);
    setCurrentEvent(null);
    setTherapyMessages([]);
  }, [gameId, setTrackedError, therapyMessages, currentEvent]);

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
    const terminal = typeof data.epilogue === "string";
    track("intervention_completed", {
      rung: 3,
      outcome: terminal ? "terminal" : "returned_to_story",
      turnsTaken: 0,
      eventNumber: currentEvent?.eventNumber ?? scenesPlayedRef.current,
      mode: "solo",
    });
    if (typeof data.epilogue === "string") {
      setEpilogue(data.epilogue);
      // The third route into an epilogue, and the reason `route` exists: a
      // removal determination is not a completed arc and not an early exit.
      track("epilogue_reached", {
        route: "intervention_terminal",
        eventNumber: currentEvent?.eventNumber ?? scenesPlayedRef.current,
        age: currentEvent?.age ?? 0,
        scenesPlayed: scenesPlayedRef.current,
        mode: "solo",
      });
    }
    setPhase(data.phase);
    setCurrentEvent(null);
    setInterventionText(null);
    return data.phase;
  }, [gameId, setTrackedError, currentEvent]);

  const generateReportCard = useCallback(async (userId?: string) => {
    if (!gameId) return;
    setPhase("processing");
    // The last wait in the game, and the one error_occurred{step:report_card}
    // already clustered in without anything marking its start.
    mark("processing");
    track("processing_started", {
      kind: "report_card",
      eventNumber: scenesPlayedRef.current,
      age: currentEvent?.age ?? 0,
    });
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
      const waited = secondsSince("processing");
      track("game_completed", {
        scenesPlayed: scenesPlayedRef.current,
        mode: "solo",
        ...(waited !== null ? { waitSeconds: bucketSeconds(waited) } : {}),
      });
    } catch (err) {
      setTrackedError(`Failed to generate report card: ${err instanceof Error ? err.message : String(err)}`, "report_card");
      setPhase("epilogue");
      setStreamingDocText("");
    }
  }, [gameId, epilogue, currentEvent]);

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
