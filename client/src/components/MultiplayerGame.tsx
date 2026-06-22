import { useState, useEffect, useRef } from "react";
import { useMultiplayer } from "../hooks/useMultiplayer";
import { Lobby } from "./Lobby";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";
import { Endgame } from "./Endgame";
import { ReportCard } from "./ReportCard";
import { ProcessingScreen } from "./ProcessingScreen";

const RELATIONSHIP_OPTIONS = [
  "romantic partners",
  "friends",
  "siblings",
  "ex-partners",
  "co-parents who were never together",
];

interface Props {
  /** Present when the page was opened from an invite link (?game=...). */
  joinGameId?: string;
}

export function MultiplayerGame({ joinGameId }: Props) {
  const mp = useMultiplayer();
  const [nameInput, setNameInput] = useState("");
  const [childInput, setChildInput] = useState("");
  const [relationship, setRelationship] = useState(RELATIONSHIP_OPTIONS[0]);
  const [gateReady, setGateReady] = useState(false);

  const state = mp.state;
  const mySlot = mp.slot;
  const sidebarActive = state?.sidebarActive ?? null;
  const inMySidebar = sidebarActive !== null && sidebarActive === mySlot;
  const inOtherSidebar = sidebarActive !== null && sidebarActive !== mySlot;

  // Reset local ready toggle when the server loads a new event preview so the
  // player must explicitly confirm they have read the description.
  const prevEventNumberRef = useRef(state?.currentEventNumber ?? 0);
  useEffect(() => {
    const cur = state?.currentEventNumber ?? 0;
    if (cur !== prevEventNumberRef.current) {
      setGateReady(false);
      prevEventNumberRef.current = cur;
    }
  }, [state?.currentEventNumber]);

  // ---- Setup: create or join ----
  if (!mp.gameId) {
    return (
      <div className="app">
        <div className="start-screen">
          <div className="start-glow" aria-hidden="true" />
          <h1>raising intelligences</h1>
          {mp.error && <p className="error">{mp.error}</p>}
          {joinGameId ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (nameInput.trim()) mp.joinGame(joinGameId, nameInput.trim());
              }}
            >
              <p className="dim">your name</p>
              <input
                className="name-input"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                autoFocus
              />
              <button className="btn" type="submit" disabled={!nameInput.trim()}>
                join
              </button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (childInput.trim() && nameInput.trim())
                  mp.createGame(childInput.trim(), relationship, nameInput.trim());
              }}
            >
              <p className="dim">name your child</p>
              <input
                className="name-input"
                value={childInput}
                onChange={(e) => setChildInput(e.target.value)}
                autoFocus
              />
              <p className="dim" style={{ marginTop: 24 }}>your name</p>
              <input
                className="name-input"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
              />
              <p className="dim" style={{ marginTop: 24 }}>your relationship</p>
              <select
                className="relationship-select"
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
              >
                {RELATIONSHIP_OPTIONS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
              <button
                className="btn"
                type="submit"
                disabled={!childInput.trim() || !nameInput.trim()}
              >
                create game
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ---- Lobby: first event_intro, before the story begins ----
  if (!state || (state.phase === "event_intro" && state.currentEventNumber === 0)) {
    return (
      <div className="app fade-in">
        <Lobby
          gameId={mp.gameId}
          slot={mySlot}
          players={mp.players}
          childName={state?.childName ?? childInput}
          onReady={mp.ready}
        />
      </div>
    );
  }

  // ---- Between chapters: two-step ready gate ----
  // Step 1 (currentEvent null): both ready → server generates and previews the event
  // Step 2 (currentEvent set): both ready → server starts family chat
  if (state.phase === "event_intro") {
    return (
      <div className="app fade-in">
        <div className="event-intro">
          {state.currentEvent ? (
            <>
              <p className="age-marker">— age {state.currentEvent.age} —</p>
              <p className="event-description">{state.currentEvent.description}</p>
            </>
          ) : (
            <p className="dim">the story continues…</p>
          )}
          <ReadyToggle
            ready={gateReady}
            onToggle={(v) => {
              setGateReady(v);
              mp.ready(v);
            }}
            label={state.currentEvent ? "ready to begin" : "ready for the next chapter"}
            players={mp.players}
          />
        </div>
      </div>
    );
  }

  // ---- Family chat / sidebar / adult chat ----
  if (state.phase === "family_chat" || state.phase === "sidebar" || state.phase === "adult_chat") {
    const inputDisabled = mp.isStreaming || inOtherSidebar;
    return (
      <div className="app fade-in">
        <p className="age-marker">
          {state.phase === "adult_chat" ? "— adulthood —" : `— age ${state.currentEvent?.age} —`}
          {state.currentEventNumber > 0 && state.phase !== "adult_chat" && (
            <span className="event-count"> · {state.currentEventNumber} of {state.totalEvents}</span>
          )}
        </p>

        {inMySidebar && <p className="sidebar-banner">private conversation</p>}
        {inOtherSidebar && (
          <p className="sidebar-banner dim">the other parent is talking privately…</p>
        )}

        <div className="chat">
          <MessageList
            messages={state.messages}
            streamingMessage={mp.streamingMessage}
            childName={state.childName}
          />
          <MessageInput
            onSend={mp.sendMessage}
            disabled={inputDisabled}
            messagesRemaining={state.messagesRemaining}
          />
          <div className="chat-controls">
            {state.phase === "family_chat" && !sidebarActive && mySlot && !state.sidebarUsed[mySlot] && (
              <button className="btn btn-secondary" onClick={mp.startSidebar} disabled={mp.isStreaming}>
                talk privately
              </button>
            )}
            {inMySidebar && (
              <button className="btn btn-secondary" onClick={mp.endSidebar} disabled={mp.isStreaming}>
                rejoin family
              </button>
            )}
            {!sidebarActive && (
              <button className="btn btn-secondary" onClick={mp.endChat} disabled={mp.isStreaming}>
                {state.phase === "adult_chat" ? "finish → report card" : "end conversation"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === "processing") {
    return (
      <div className="app">
        <ProcessingScreen childName={state.childName} age={state.currentEvent?.age} />
      </div>
    );
  }

  // ---- Debrief: parents-only beat, then ready up to continue ----
  if (state.phase === "debrief") {
    return (
      <div className="app fade-in">
        <div className="debrief-enhanced">
          <div className="debrief-text-block">
            <p className="debrief-line-1">a moment between you two</p>
            <p className="debrief-line-2">what just happened?</p>
          </div>
          <ReadyToggle
            ready={gateReady}
            onToggle={(v) => {
              setGateReady(v);
              mp.ready(v);
            }}
            label="ready to continue"
            players={mp.players}
          />
          <button className="btn btn-secondary" onClick={mp.startEpilogue}>
            end childhood → epilogue
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "epilogue") {
    return (
      <div className="app fade-in">
        <Endgame epilogue={mp.epilogue} onContinue={mp.generateReportCard} />
      </div>
    );
  }

  if (state.phase === "report_card") {
    return (
      <div className="app fade-in">
        <ReportCard reportCard={mp.reportCard} childName={state.childName} />
      </div>
    );
  }

  return (
    <div className="app">
      <p>{state.phase}</p>
    </div>
  );
}

function ReadyToggle({
  ready,
  onToggle,
  label,
  players,
}: {
  ready: boolean;
  onToggle: (v: boolean) => void;
  label: string;
  players: { ready: boolean }[];
}) {
  const readyCount = players.filter((p) => p.ready).length;
  return (
    <div className="ready-toggle">
      <button className="btn" onClick={() => onToggle(!ready)}>
        {ready ? "waiting…" : label}
      </button>
      <p className="dim ready-count">{readyCount} of {players.length} ready</p>
    </div>
  );
}
