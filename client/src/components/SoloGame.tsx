import { useState, useEffect, useCallback } from "react";
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const existingId = params.get("game");
    if (existingId && !gameId) {
      loadGame(existingId);
    }
  }, []);

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
    const resultPhase = await endDebrief();
    if (resultPhase === "event_intro") {
      await nextEvent();
    }
    setLoadingEvent(false);
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
          // `|| error` is the escape hatch. A failed load leaves currentEvent
          // null forever, and this screen has no error banner and no retry — so
          // without it a dead /next-event is a spinner with no way out.
          // Releasing on the error hands the player to EventIntro, whose
          // `onReady={currentEvent ? beginChat : handleNextEvent}` is the retry.
          // (Multiplayer's equivalent hatch is the server clearing the ready
          // flags, which drops both clients back to the lobby.)
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
          extraButton={
            <button onClick={generateEpilogue} className="btn btn-secondary" data-testid="btn-epilogue">
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
          onEndChat={generateReportCard}
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
