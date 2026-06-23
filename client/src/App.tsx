import { useState, useEffect } from "react";
import { SoloGame } from "./components/SoloGame";
import { MultiplayerGame } from "./components/MultiplayerGame";
import { track } from "./analytics";

const TAGLINES = [
  // funny
  "they will absolutely eat that off the floor.",
  "nap schedules are load-bearing infrastructure.",
  "you said you'd never do that. you did that.",
  "they negotiated. you lost.",
  "you bought a book about this. you did not finish it.",
  "someone ate the crayons.",
  "they're going through a phase. probably.",
  "you googled something you can't unread.",
  "you're outvoted.",
  "they have opinions about pasta shape.",
  "you are not as in charge as you thought.",
  "the dog is doing fine, actually.",

  // mysterious
  "they know something you don't.",
  "something happened at school. no one is telling you.",
  "they went quiet all of a sudden.",
  "there are years you won't remember.",
  "the house gets so quiet.",
  "they dream of things you'll never know.",
  "you said the wrong thing at exactly the right moment.",
  "they're becoming someone you haven't met yet.",

  // deep
  "you're raising a person who will outlive you.",
  "they will carry this forever.",
  "you became your parents on a tuesday.",
  "love is mostly logistics.",
  "every decision branches into a thousand futures.",
  "it turns out love isn't enough. and also it is.",
  "you only get one shot at this. you're in the middle of it.",
  "good intentions, variable outcomes.",
  "you learned this from someone too.",

  // evocative
  "a bedroom door, closing.",
  "the backseat on a long drive.",
  "their voice changed overnight.",
  "the last time you carried them, you didn't know it was the last time.",
  "a drawing on the refrigerator.",
  "you kept their shoes.",
  "the years go by.",
  "hold on.",
  "something is always happening.",
  "a family, in fragments.",
];

const TAGLINE = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];

type Mode = "choose" | "solo" | "multiplayer";
type Theme = "" | "theme-ocean-grunge" | "theme-cyber";

const THEMES: { id: Theme; label: string }[] = [
  { id: "theme-ocean-grunge",  label: "ocean" },
  { id: "",                    label: "lo-fi" },
  { id: "theme-cyber",         label: "cyber" },
];

export function App() {
  const joinGameId = new URLSearchParams(window.location.search).get("game") ?? undefined;
  const [mode, setMode] = useState<Mode>(joinGameId ? "multiplayer" : "choose");
  const [theme, setTheme] = useState<Theme>("theme-ocean-grunge");

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
        <p className="dim">{TAGLINE}</p>
        <div className="mode-choice">
          <button className="btn" onClick={() => { track("mode_selected", { mode: "multiplayer" }); setMode("multiplayer"); }}>
            play with a partner
          </button>
          <button className="btn btn-secondary" onClick={() => { track("mode_selected", { mode: "solo" }); setMode("solo"); }}>
            play solo
          </button>
        </div>
        <div className="theme-picker">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-btn${theme === t.id ? " theme-btn-active" : ""}`}
              onClick={() => { track("theme_selected", { theme: t.label }); setTheme(t.id); }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
