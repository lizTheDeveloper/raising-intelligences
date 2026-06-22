import { useState } from "react";
import { useGame } from "../hooks/useGame";
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
    isStreaming,
    createGame,
    nextEvent,
    beginChat,
    sendMessage,
    endChat,
    endDebrief,
    epilogue,
    reportCard,
    generateEpilogue,
    generateReportCard,
  } = useGame();

  const [nameInput, setNameInput] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [loadingEvent, setLoadingEvent] = useState(false);

  const handleStart = async () => {
    if (!nameInput.trim() || isCreating) return;
    setIsCreating(true);
    try {
      await createGame(nameInput.trim(), "single parent");
    } finally {
      setIsCreating(false);
    }
  };

  const handleNextEvent = async () => {
    setLoadingEvent(true);
    await nextEvent();
    setLoadingEvent(false);
  };

  if (phase === "start") {
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
            <button type="submit" className="btn" disabled={!nameInput.trim() || isCreating}>
              {isCreating ? "starting…" : "begin"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (phase === "event_intro") {
    return (
      <div className="app">
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
        <p className="age-marker">— age {currentEvent?.age} —</p>
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
        <ProcessingScreen childName={childName} age={currentEvent?.age} gameId={gameId} />
      </div>
    );
  }

  if (phase === "debrief") {
    return (
      <div className="app">
        <Debrief onContinue={endDebrief} />
        <div className="debrief">
          <button onClick={generateEpilogue} className="btn btn-secondary">
            end childhood → epilogue
          </button>
        </div>
      </div>
    );
  }

  if (phase === "epilogue") {
    return (
      <div className="app">
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
      <p>{phase}</p>
    </div>
  );
}
