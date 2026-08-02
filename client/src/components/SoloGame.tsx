import { useState, useEffect, useCallback, useRef } from "react";
import { track, mark, secondsSince, bucketSeconds } from "../analytics";
import {
  useGame,
  getSavedKids,
  syncKidsToServer,
  fetchServerKids,
  mergeKids,
  THERAPY_TURN_CAP,
} from "../hooks/useGame";
import type { SavedKid } from "../hooks/useGame";
import { GuardianScreen } from "./GuardianScreen";
import { EventIntro } from "./EventIntro";
import { Chat } from "./Chat";
import { Debrief } from "./Debrief";
import { ConsultScreen } from "./ConsultScreen";
import { TherapyScreen } from "./TherapyScreen";
import { CpsScreen } from "./CpsScreen";
import { Endgame } from "./Endgame";
import { ReportCard } from "./ReportCard";
import { ProcessingScreen } from "./ProcessingScreen";
import { ChildPortrait } from "./ChildPortrait";
import { FamilyAlbum } from "./FamilyAlbum";

/** Dark Play intervention ladder — structural rung numbers only, never plot
 *  nouns, so the analytics payload stays free of story content. */
const RUNG_BY_PHASE: Record<string, number> = { consult: 1, therapy: 2, cps_review: 3 };

/** Where the saved-kids picker parks its intent across the reload it triggers.
 *  `handleResume` navigates rather than loading in place, so the resume lands
 *  on the `?game=` path and would otherwise be indistinguishable from a link. */
const RESUME_SOURCE_KEY = "ri_resume_source";

export function SoloGame() {
  const {
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
    loadGame,
    createGame,
    nextEvent,
    beginChat,
    sendMessage,
    endChat,
    endDebrief,
    interventionText,
    therapyMessages,
    endConsult,
    sendTherapyMessage,
    endTherapy,
    endCps,
    epilogue,
    reportCard,
    error,
    generateEpilogue,
    generateReportCard,
  } = useGame();

  const [nameInput, setNameInput] = useState("");
  const [loadingEvent, setLoadingEvent] = useState(false);
  const [showGuardian, setShowGuardian] = useState(false);
  const [matrixUser, setMatrixUser] = useState<string | null>(
    () => window.matrixAuth?.getUserId() ?? null
  );
  const [cloudKids, setCloudKids] = useState<SavedKid[]>([]);
  const [showAlbum, setShowAlbum] = useState(false);

  /** eventNumbers whose debrief screen has already been counted. A Set, not a
   *  boolean: the debrief is a per-scene screen and a re-render must not
   *  re-fire it, but scene 4's debrief is genuinely a different view from
   *  scene 3's. */
  const debriefSeenRef = useRef<Set<number>>(new Set());
  /** Same idea for the intervention rungs, keyed `phase:eventNumber`. */
  const interventionSeenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const existingId = params.get("game");
    if (existingId && !gameId) {
      // The picker below hands off through sessionStorage because it resumes by
      // navigating; anything else arriving with a ?game= is a link.
      let source: "url" | "saved_list" = "url";
      try {
        if (sessionStorage.getItem(RESUME_SOURCE_KEY) === "saved_list") source = "saved_list";
        sessionStorage.removeItem(RESUME_SOURCE_KEY);
      } catch {
        /* storage disabled — a resume is still a resume, just an unattributed one */
      }
      loadGame(existingId, source);
    }
  }, []);

  // Time on the naming screen, for setup_submitted's secondsOnSetup. Marked
  // when the screen becomes current rather than at mount, so a game that
  // returns to `start` measures the second visit and not the first.
  useEffect(() => {
    if (phase === "start") mark("setup");
  }, [phase]);

  /**
   * The debrief screen — the single most important missing event in the game.
   * Ref-guarded per eventNumber so React re-renders cannot inflate it, and
   * paired with useGame's `processing_started` mark so the ~68s LLM wait and
   * the decision that follows it stop being the same undifferentiated gap.
   */
  useEffect(() => {
    if (phase !== "debrief") return;
    const eventNumber = currentEvent?.eventNumber ?? 0;
    if (debriefSeenRef.current.has(eventNumber)) return;
    debriefSeenRef.current.add(eventNumber);
    const waited = secondsSince("processing");
    track("debrief_viewed", {
      eventNumber,
      age: currentEvent?.age ?? 0,
      mode: "solo",
      ...(waited !== null ? { waitSeconds: bucketSeconds(waited) } : {}),
    });
  }, [phase, currentEvent]);

  /** The Dark Play ladder: a whole shipped subsystem that emitted nothing. */
  useEffect(() => {
    const rung = RUNG_BY_PHASE[phase];
    if (!rung) return;
    const eventNumber = currentEvent?.eventNumber ?? 0;
    const key = `${phase}:${eventNumber}`;
    if (interventionSeenRef.current.has(key)) return;
    interventionSeenRef.current.add(key);
    track("intervention_started", {
      rung,
      eventNumber,
      age: currentEvent?.age ?? 0,
      mode: "solo",
    });
  }, [phase, currentEvent]);

  const syncOnLogin = useCallback(async (userId: string) => {
    setMatrixUser(userId);
    await syncKidsToServer(userId);
    const remote = await fetchServerKids(userId);
    const local = getSavedKids();
    setCloudKids(mergeKids(local, remote));
  }, []);

  useEffect(() => {
    const onReady = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.loggedIn && detail?.userId) syncOnLogin(detail.userId);
    };
    const onLogin = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.userId) syncOnLogin(detail.userId);
    };
    window.addEventListener("matrixAuthReady", onReady);
    window.addEventListener("matrixAuthLogin", onLogin);
    return () => {
      window.removeEventListener("matrixAuthReady", onReady);
      window.removeEventListener("matrixAuthLogin", onLogin);
    };
  }, [syncOnLogin]);

  const handleStart = async () => {
    if (!nameInput.trim()) return;
    // Emitted BEFORE the POST, deliberately: it is the numerator for the
    // mode_selected → game_started loss, and a create that fails server-side
    // must still count as an attempt. Without it, "abandoned the form" and
    // "the request failed" were the same shape — and
    // error_occurred{step:create_game} has never once appeared in 30d.
    const setupSeconds = secondsSince("setup");
    track("setup_submitted", {
      mode: "solo",
      nameProvided: true,
      ...(setupSeconds !== null ? { secondsOnSetup: bucketSeconds(setupSeconds) } : {}),
    });
    setShowGuardian(true);
    const id = await createGame(nameInput.trim());
    if (!id) {
      setShowGuardian(false);
      return;
    }
    if (matrixUser) syncKidsToServer(matrixUser);
    // Deliberately does NOT load the first event here any more.
    //
    // It used to, in parallel with the guardian quiz — which removed the wait
    // but left scene 1 personality-blind, because the world manager ran before
    // the OCEAN answers and confessionals existed. The seed has to exist first,
    // so the load moves to handleSeedReady below. Running the quiz concurrently
    // with generation is the wrong fix; running it *before* is the right one.
  };

  // The personality seed has landed → build scene 1, now that the world manager
  // can actually see who these parents are. The guardian screen's portrait
  // reveal and closing beat play over this call.
  const handleSeedReady = useCallback(async () => {
    setLoadingEvent(true);
    await nextEvent();
    setLoadingEvent(false);
  }, [nextEvent]);

  const handleNextEvent = async () => {
    setLoadingEvent(true);
    await nextEvent();
    setLoadingEvent(false);
  };

  // After debrief the server resets to event_intro with no current event.
  // Automatically kick off the next event load so the player sees the spinner
  // rather than a bare "begin" button (fixes #21 double-begin flow).
  // Dark Play Plan 3 — a due rung reroutes end-debrief into consult/therapy/
  // cps_review instead of event_intro; only advance to the next event when
  // no rung fired (phase came back "event_intro"), otherwise let the phase
  // dispatch below render the intervention screen.
  const handleDebrief = async () => {
    setLoadingEvent(true);
    // Captured before the call: endDebrief clears currentEvent on the
    // non-intervention path, so reading it afterwards would report zeroes.
    const eventNumber = currentEvent?.eventNumber ?? 0;
    const age = currentEvent?.age ?? 0;
    const messagesSentThisScene = 12 - messagesRemaining;
    const resultPhase = await endDebrief();
    track("debrief_completed", {
      eventNumber,
      age,
      exit: "continue",
      messagesSentThisScene,
      interventionQueued:
        resultPhase === "consult" || resultPhase === "therapy" || resultPhase === "cps_review",
      mode: "solo",
    });
    if (resultPhase === "event_intro") {
      await nextEvent();
    }
    setLoadingEvent(false);
  };

  /** The other way off the debrief screen: ending childhood on purpose. This is
   *  a choice, not churn, and it is why more sessions reach an epilogue than
   *  ever reach the last scene. */
  const handleEndStoryEarly = () => {
    track("debrief_completed", {
      eventNumber: currentEvent?.eventNumber ?? 0,
      age: currentEvent?.age ?? 0,
      exit: "end_story_early",
      messagesSentThisScene: 12 - messagesRemaining,
      interventionQueued: false,
      mode: "solo",
    });
    generateEpilogue(undefined, "ended_early");
  };

  // Dark Play Plan 3 — consult/therapy always route back to event_intro
  // (END_INTERVENTION never terminates the game), so both continuations
  // mirror handleDebrief: end the intervention, then load the next event.
  const handleConsultContinue = async () => {
    setLoadingEvent(true);
    await endConsult();
    await nextEvent();
    setLoadingEvent(false);
  };

  const handleTherapyConclude = async () => {
    setLoadingEvent(true);
    await endTherapy();
    await nextEvent();
    setLoadingEvent(false);
  };

  // CPS review CAN be terminal (a "removal" determination). endCps returns
  // the resulting phase: "epilogue" means the server already generated the
  // removal epilogue and set it into `epilogue` state — the existing
  // `phase === "epilogue"` branch below renders Endgame off that state, so
  // nothing further is needed here. Any other phase (event_intro on
  // "stay"/"safety_plan") advances to the next event, same as consult/therapy.
  const handleCpsContinue = async () => {
    const resultPhase = await endCps();
    if (resultPhase === "epilogue") return;
    setLoadingEvent(true);
    await nextEvent();
    setLoadingEvent(false);
  };

  if (showAlbum && matrixUser) {
    return (
      <div className="app">
        <FamilyAlbum userId={matrixUser} onBack={() => setShowAlbum(false)} />
      </div>
    );
  }

  if (phase === "start") {
    const savedKids = cloudKids.length > 0 ? cloudKids : getSavedKids();
    const handleResume = (kid: { gameId: string; childName: string }) => {
      // Survives the navigation below so the mount effect can tell a picker
      // resume from a pasted/bookmarked link.
      try {
        sessionStorage.setItem(RESUME_SOURCE_KEY, "saved_list");
      } catch {
        /* non-fatal: the resume still works, it just reports as "url" */
      }
      const url = new URL(window.location.href);
      url.searchParams.set("game", kid.gameId);
      url.searchParams.set("mode", "solo");
      window.location.href = url.toString();
    };
    const handleLogin = () => window.matrixAuth?.showLoginModal();
    const handleLogout = async () => {
      await window.matrixAuth?.logout();
      setMatrixUser(null);
      setCloudKids([]);
    };
    return (
      <div className="app">
        <div className="start-screen">
          <div className="start-glow" aria-hidden="true" />
          <h1>raising intelligences</h1>
          <p className="dim">name your child</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleStart();
            }}
          >
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              autoFocus
              className="name-input"
            />
            <button type="submit" className="btn" data-testid="btn-begin" disabled={!nameInput.trim()}>
              begin
            </button>
          </form>
          {savedKids.length > 0 && (
            <div className="saved-kids">
              <p className="dim">or continue raising...</p>
              {savedKids.map((kid) => (
                <button
                  key={kid.gameId}
                  className="btn btn-secondary saved-kid-btn"
                  onClick={() => handleResume(kid)}
                >
                  {kid.childName}
                </button>
              ))}
            </div>
          )}
          {matrixUser && (
            <button
              className="btn btn-secondary"
              onClick={() => setShowAlbum(true)}
              style={{ marginTop: "1rem" }}
            >
              my family
            </button>
          )}
          <div className="auth-section">
            {matrixUser ? (
              <button className="btn-link" onClick={handleLogout}>
                {matrixUser.split(":")[0].slice(1)} — sign out
              </button>
            ) : (
              <button className="btn-link" onClick={handleLogin}>
                sign in to sync across devices
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (showGuardian && (phase === "start" || phase === "event_intro")) {
    return (
      <div className="app">
        <GuardianScreen
          childName={childName || nameInput}
          gameId={gameId}
          // `currentEvent !== null` is required, not decorative: the game sits
          // in `event_intro` from creation onward, so without it this would
          // read "ready" before scene 1 had even been requested.
          //
          // `|| error` is the escape hatch for a failed /next-event, which
          // leaves currentEvent null forever. Releasing on the error hands the
          // player to EventIntro, whose
          // `onReady={currentEvent ? beginChat : handleNextEvent}` is the retry.
          // The screen's own error surface covers the other failure — a failed
          // personality POST — with a "try again" that resubmits.
          // (Multiplayer's hatch is now that same surface, fed by the server's
          // room-wide error; it used to be the server clearing the ready flags,
          // which dropped both clients back to the lobby and lost the quiz.)
          eventReady={
            phase === "event_intro" && !loadingEvent && (currentEvent !== null || error !== null)
          }
          onReady={() => setShowGuardian(false)}
          onSeedReady={handleSeedReady}
        />
      </div>
    );
  }

  if (phase === "event_intro") {
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <EventIntro
          event={currentEvent}
          onReady={currentEvent ? beginChat : handleNextEvent}
          waiting={loadingEvent}
          gameId={gameId}
        />
      </div>
    );
  }

  if (phase === "family_chat") {
    // Per-scene transcript — the same bug as multiplayer: `messages` is
    // cumulative for the whole game, so a resumed game rendered every past
    // scene's conversation under the current scene's header.
    //
    // The `undefined` clause is load-bearing, not laziness: useGame's
    // sendMessage appends the player's own message optimistically with no
    // eventNumber and nothing ever replaces it with the server's copy, so a
    // strict equality test would hide every parent message permanently. An
    // un-stamped message was created by this client, in this scene, just now.
    const sceneMessages = messages.filter((m) => {
      if (m.chatType === "debrief") return false;
      return m.eventNumber === undefined || m.eventNumber === currentEvent?.eventNumber;
    });
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <div className="chat-portrait-header">
          <ChildPortrait age={currentEvent?.age ?? 3} size={64} gameId={gameId} gender={childGender} />
          <p className="age-marker">— age {currentEvent?.age} —</p>
        </div>
        {currentEvent?.description && (
          <p className="event-context">{currentEvent.description}</p>
        )}
        <Chat
          messages={sceneMessages}
          streamingMessage={streamingMessage}
          childName={childName}
          messagesRemaining={messagesRemaining}
          isStreaming={isStreaming}
          onSend={sendMessage}
          onEndChat={endChat}
        />
      </div>
    );
  }

  if (phase === "processing") {
    return (
      <div className="app">
        <ProcessingScreen childName={childName} age={currentEvent?.age} gameId={gameId} streamingText={streamingDocText} />
      </div>
    );
  }

  if (phase === "debrief") {
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <Debrief
          onContinue={handleDebrief}
          // Deliberate early exit — KEPT. A parent may end childhood before the
          // arc runs out, and the auto-advance in useGame's nextEvent does not
          // replace it. Wrapped in an arrow rather than passed directly:
          // generateEpilogue now takes an optional game id, so a bare
          // `onClick={generateEpilogue}` would hand it the click event.
          extraButton={
            <button onClick={handleEndStoryEarly} className="btn btn-secondary" data-testid="btn-epilogue">
              end childhood → epilogue
            </button>
          }
        />
      </div>
    );
  }

  if (phase === "consult") {
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <ConsultScreen text={interventionText ?? ""} onContinue={handleConsultContinue} />
      </div>
    );
  }

  if (phase === "therapy") {
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <TherapyScreen
          messages={therapyMessages}
          streamingReply={streamingDocText}
          canSend={therapyMessages.filter((m) => m.speaker === "parent").length < THERAPY_TURN_CAP}
          onSend={sendTherapyMessage}
          onConclude={handleTherapyConclude}
        />
      </div>
    );
  }

  if (phase === "cps_review") {
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <CpsScreen text={interventionText ?? ""} onContinue={handleCpsContinue} />
      </div>
    );
  }

  if (phase === "epilogue") {
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <Endgame epilogue={epilogue} onContinue={() => generateReportCard(matrixUser ?? undefined)} />
      </div>
    );
  }

  if (phase === "adult_chat") {
    // Same per-scene filter as family_chat above, including the `undefined`
    // clause — useGame appends the player's own message optimistically with no
    // eventNumber, so strict equality would hide every parent message. This is
    // safe now that START_ADULT_CHAT advances currentEventNumber: the adult
    // conversation is its own scene, so without the filter the last childhood
    // conversation renders above it.
    const adultMessages = messages.filter((m) => {
      if (m.chatType === "debrief") return false;
      return m.eventNumber === undefined || m.eventNumber === currentEvent?.eventNumber;
    });
    return (
      <div className="app">
        <div className="chat-portrait-header">
          <ChildPortrait age={22} size={64} gameId={gameId} gender={childGender} />
          <p className="age-marker">— adulthood —</p>
        </div>
        <Chat
          messages={adultMessages}
          streamingMessage={streamingMessage}
          childName={childName}
          messagesRemaining={messagesRemaining}
          isStreaming={isStreaming}
          onSend={sendMessage}
          // NOT `onEndChat={generateReportCard}`. Chat calls this as
          // `onClick={onEndChat}`, so the bare reference handed React's
          // MouseEvent to `generateReportCard(userId?)` — which meant the
          // album-generation query string became `?userId=[object Object]`,
          // filing the family album under a garbage user and never under the
          // signed-in one. Same class of bug as the Debrief button's arrow
          // wrapper, in the one place it wasn't wrapped.
          onEndChat={() => {
            track("endgame_conversation_ended", {
              messagesSent: 12 - messagesRemaining,
              hitCap: messagesRemaining === 0,
              abandoned: false,
              mode: "solo",
            });
            generateReportCard(matrixUser ?? undefined);
          }}
        />
      </div>
    );
  }

  if (phase === "report_card") {
    return (
      <div className="app">
        <ReportCard reportCard={reportCard} childName={childName} />
        {matrixUser && (
          <div style={{ textAlign: "center", marginTop: "1.5rem" }}>
            <button className="btn" onClick={() => setShowAlbum(true)}>
              view your family
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      {error && <p className="error-banner">{error}</p>}
      <p className="dim">{phase}</p>
    </div>
  );
}
