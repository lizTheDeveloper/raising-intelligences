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
  "they will remember everything you do wrong.",
  "they called you by your first name once, as a threat.",
  "you will never win an argument at 3am.",
  "they have a system. you don't know what it is.",
  "you said 'we'll see.' that was a mistake.",
  "they've been planning this since before you walked in.",
  "you're not tired enough to deal with this right now. but here we are.",
  "they will find the one thing you said not to touch.",
  "someone is about to cry about something completely trivial.",
  "they will ask the same question forty times in a row.",
  "you are being audited. by a four-year-old.",
  "they will cry because you cut their sandwich wrong.",
  "the chaos is the point.",
  "you said 'five more minutes.' that was a threat.",
  "they have a lawyer now. they're seven.",

  // mysterious
  "they know something you don't.",
  "something happened at school. no one is telling you.",
  "they went quiet all of a sudden.",
  "there are years you won't remember.",
  "the house gets so quiet.",
  "they dream of things you'll never know.",
  "you said the wrong thing at exactly the right moment.",
  "they're becoming someone you haven't met yet.",
  "there's a story they'll tell about this. you're not in it.",
  "something changed. you're not sure when.",
  "they saw something. you don't know what it was.",
  "the silence means something. you'll figure it out later.",
  "they've already decided. they're just waiting.",
  "there's a version of this they'll remember forever.",
  "you'll never know exactly when it started.",
  "they're waiting for you to notice something.",
  "something is happening that you can't see yet.",

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
  "you're making someone's memory right now.",
  "they'll be okay. probably. you hope.",
  "the things they need from you aren't things you have words for.",
  "you're teaching them how to be a person. you're not sure you know how.",
  "the smallest moments are the ones that matter most. you never know which ones.",
  "you're both figuring it out.",
  "there's no manual. there never was.",
  "they need you to be steady. you're not always steady.",
  "the person you're raising will be different from anyone you've known. including you.",
  "you're doing something no one taught you to do.",
  "they'll thank you later. or they won't. neither means what you think it means.",
  "love is the easy part. it's the tuesday nights that break you.",
  "you're building something you'll never see finished.",

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
  "the sound of small feet on stairs.",
  "you'll think about this moment forever.",
  "the way they said your name.",
  "everything they learned, they learned from someone.",
  "they asked you to stay. you stayed.",
  "the kitchen after everyone's gone to bed.",
  "a promise you made in the dark.",
  "they looked at you like you were everything.",
  "the drive home was quiet.",
  "you didn't know it was important until later.",
  "something small, something forever.",
  "the way children remember everything you don't.",
  "a hand reaching up.",
  "the weight of them, sleeping.",
  "you're making this up as you go. so is everyone.",
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
  const params = new URLSearchParams(window.location.search);
  const joinGameId = params.get("game") ?? undefined;
  const isSoloResume = joinGameId && params.get("mode") === "solo";
  const [mode, setMode] = useState<Mode>(isSoloResume ? "solo" : joinGameId ? "multiplayer" : "choose");
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
