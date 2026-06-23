import { useState, useEffect, useCallback } from "react";
import { useGame, getSavedKids, syncKidsToServer, fetchServerKids, mergeKids } from "../hooks/useGame";
import type { SavedKid } from "../hooks/useGame";
import { GuardianScreen } from "./GuardianScreen";
import { EventIntro } from "./EventIntro";
import { Chat } from "./Chat";
import { Debrief } from "./Debrief";
import { Endgame } from "./Endgame";
import { ReportCard } from "./ReportCard";
import { ProcessingScreen } from "./ProcessingScreen";

export function SoloGame() {
  const {
    gameId,
    phase,
    childName,
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
    const id = await createGame(nameInput.trim());
    if (!id) return;
    if (matrixUser) syncKidsToServer(matrixUser);
    setShowGuardian(true);
    setLoadingEvent(true);
    await nextEvent(id);
    setLoadingEvent(false);
  };

  const handleNextEvent = async () => {
    setLoadingEvent(true);
    await nextEvent();
    setLoadingEvent(false);
  };

  // After debrief the server resets to event_intro with no current event.
  // Automatically kick off the next event load so the player sees the spinner
  // rather than a bare "begin" button (fixes #21 double-begin flow).
  const handleDebrief = async () => {
    setLoadingEvent(true);
    await endDebrief();
    await nextEvent();
    setLoadingEvent(false);
  };

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
          eventReady={phase === "event_intro" && !loadingEvent}
          onReady={() => setShowGuardian(false)}
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
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <p className="age-marker">— age {currentEvent?.age} —</p>
        {currentEvent?.description && (
          <p className="event-context">{currentEvent.description}</p>
        )}
        <Chat
          messages={messages}
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
        <Debrief onContinue={handleDebrief} />
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0 32px" }}>
          <button onClick={generateEpilogue} className="btn btn-secondary" data-testid="btn-epilogue">
            end childhood → epilogue
          </button>
        </div>
      </div>
    );
  }

  if (phase === "epilogue") {
    return (
      <div className="app">
        {error && <p className="error-banner">{error}</p>}
        <Endgame epilogue={epilogue} onContinue={generateReportCard} />
      </div>
    );
  }

  if (phase === "adult_chat") {
    return (
      <div className="app">
        <p className="age-marker">— adulthood —</p>
        <Chat
          messages={messages}
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
