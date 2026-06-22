import { useState } from "react";
import { SoloGame } from "./components/SoloGame";
import { MultiplayerGame } from "./components/MultiplayerGame";

type Mode = "choose" | "solo" | "multiplayer";

export function App() {
  // An invite link (?game=<id>) drops the second player straight into the
  // multiplayer join flow.
  const joinGameId = new URLSearchParams(window.location.search).get("game") ?? undefined;
  const [mode, setMode] = useState<Mode>(joinGameId ? "multiplayer" : "choose");

  if (mode === "solo") return <SoloGame />;
  if (mode === "multiplayer") return <MultiplayerGame joinGameId={joinGameId} />;

  return (
    <div className="app">
      <div className="start-screen">
        <div className="start-glow" aria-hidden="true" />
        <h1>raising intelligences</h1>
        <p className="dim">raise a child through conversation</p>
        <div className="mode-choice">
          <button className="btn" onClick={() => setMode("multiplayer")}>
            play with a partner
          </button>
          <button className="btn btn-secondary" onClick={() => setMode("solo")}>
            play solo
          </button>
        </div>
      </div>
    </div>
  );
}
