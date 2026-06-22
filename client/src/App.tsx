import { useState, useEffect } from "react";
import { SoloGame } from "./components/SoloGame";
import { MultiplayerGame } from "./components/MultiplayerGame";

type Mode = "choose" | "solo" | "multiplayer";
type Theme = "" | "theme-ocean-grunge" | "theme-cyber";

const THEMES: { id: Theme; label: string }[] = [
  { id: "",                    label: "lo-fi" },
  { id: "theme-ocean-grunge",  label: "ocean" },
  { id: "theme-cyber",         label: "cyber" },
];

export function App() {
  const joinGameId = new URLSearchParams(window.location.search).get("game") ?? undefined;
  const [mode, setMode] = useState<Mode>(joinGameId ? "multiplayer" : "choose");
  const [theme, setTheme] = useState<Theme>("");

  // Apply theme to body so it persists across all game screens
  useEffect(() => {
    document.body.className = theme;
  }, [theme]);

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
        <div className="theme-picker">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-btn${theme === t.id ? " theme-btn-active" : ""}`}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
