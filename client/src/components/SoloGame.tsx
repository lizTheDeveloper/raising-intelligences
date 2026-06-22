import { useState } from "react";
import { useGame } from "../hooks/useGame";
import { EventIntro } from "./EventIntro";
import { Chat } from "./Chat";
import { Debrief } from "./Debrief";
import { Endgame } from "./Endgame";
import { ReportCard } from "./ReportCard";

export function SoloGame() {
  const {
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
    epilogue,
    reportCard,
    generateEpilogue,
    generateReportCard,
  } = useGame();

  const [nameInput, setNameInput] = useState("");
  const [relationshipInput, setRelationshipInput] = useState("romantic partners");
  const [loadingEvent, setLoadingEvent] = useState(false);

  const RELATIONSHIP_OPTIONS = [
    "romantic partners",
    "friends",
    "siblings",
    "ex-partners",
    "co-parents who were never together",
  ];

  const handleStart = async () => {
    if (!nameInput.trim()) return;
    await createGame(nameInput.trim(), relationshipInput);
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
            <p className="dim" style={{ marginTop: "24px" }}>
              your relationship
            </p>
            <select
              value={relationshipInput}
              onChange={(e) => setRelationshipInput(e.target.value)}
              className="relationship-select"
            >
              {RELATIONSHIP_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <button type="submit" className="btn" disabled={!nameInput.trim()}>
              begin
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (phase === "event_intro") {
    return (
      <div className="app">
        <EventIntro event={currentEvent} onReady={handleNextEvent} waiting={loadingEvent} />
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
        <p className="dim">time passes...</p>
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
