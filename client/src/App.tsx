import { useState, useEffect } from "react";
import { SoloGame } from "./components/SoloGame";
import { MultiplayerGame } from "./components/MultiplayerGame";
import { AdminApp } from "./components/admin/AdminApp";
import { clearResume } from "./hooks/useMultiplayer";
import { track } from "./analytics";
import { useMatrixAuth } from "./hooks/useMatrixAuth";

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
  "someone is about to cry about something completely trivial.",
  "you are being audited. by a four-year-old.",
  "they will cry because you cut their sandwich wrong.",
  "the chaos is the point.",
  "you said 'five more minutes.' that was a threat.",
  "they have a lawyer now. they're seven.",
  "they said 'you don't understand' and they were right.",
  "someone is about to negotiate like a hostage situation.",
  "they're timing you. you don't know what for.",
  "they have decided that you owe them. they're not wrong.",
  "they have developed opinions about politics and you didn't even notice when.",
  "bedtime takes forty-five minutes and involves a treaty.",
  "they told a stranger your weight.",
  "they cried because the banana broke.",
  "you are losing a battle of wills to someone who can't tie their shoes.",
  "they asked 'why' nine times and you ran out of answers by the third.",
  "they left a half-eaten apple somewhere. you will find it in three weeks.",
  "they have a favorite parent and it changes hourly.",
  "they're quiet. that's worse.",
  "they licked something in public and you pretended not to see.",
  "they told their teacher something you said in confidence.",
  "they have a grudge. they're four.",
  "they decided your cooking is 'fine' and that was the whole review.",
  "they learned the word 'actually' and now everything is worse.",
  "you've been outsmarted by someone who still believes in the tooth fairy.",
  "they weaponized 'i love you' to get out of trouble.",
  "they announced your bathroom habits to the grocery store.",
  "they picked their nose and then tried to hold your hand.",
  "the tantrum lasted longer than the movie.",
  "you are one 'but why' away from an existential crisis.",
  "they asked if you were old when dinosaurs were alive.",

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

  // heartbreakers
  "the last time they reach for your hand, you won't know it's the last time.",
  "they stopped asking you to watch. you didn't notice when.",
  "they don't remember the thing you're most proud of.",
  "the small one in the photos is gone.",
  "they're going to forget most of this. you're going to remember all of it.",
  "one day they'll describe their childhood to someone and you won't recognize it.",
  "you blinked.",

  // childhood is hard
  "they're doing all of this for the first time.",
  "they have feelings they don't have words for yet.",
  "they're the smallest person in every room they enter.",
  "nobody asked them if they were ready.",
  "the world is very loud when you're very small.",
  "they don't get to choose any of this.",
  "they need you to understand something they can't explain.",

  // you're a bad parent (you're not)
  "you checked your phone while they were talking to you.",
  "you said 'not right now' more than you said 'yes' today.",
  "you were too tired to play and they stopped asking.",
  "you lost your temper over something that didn't matter.",
  "they asked you to watch and you were looking at something else.",
  "you said 'because i said so.' you swore you never would.",
  "you counted the hours until bedtime and then missed them immediately.",

  // the things you can't unknow
  "they trust you completely. you are guessing.",
  "you will forget what their voice sounded like at three.",
  "the best day was a tuesday. you didn't know it was the best day.",
  "they're already someone. you're still finding out who.",
  "somewhere in the middle you stopped being the whole world to them.",
  "the thing you're worried about isn't the thing that'll matter.",
  "they needed you to be perfect. you needed them to forgive you for not being.",
  "every night you put them to bed is one fewer night you put them to bed.",
  "they're having an experience of their childhood that you will never fully know.",
  "you are their first experience of love. they won't remember most of it.",

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
  const isAdmin =
    window.location.pathname.endsWith("/admin") ||
    window.location.pathname.includes("/admin/");
  if (isAdmin) return <AdminApp />;

  const params = new URLSearchParams(window.location.search);
  const joinGameId = params.get("game") ?? undefined;
  const isSoloResume = joinGameId && params.get("mode") === "solo";
  const [mode, setMode] = useState<Mode>(isSoloResume ? "solo" : joinGameId ? "multiplayer" : "choose");
  const [theme, setTheme] = useState<Theme>("theme-ocean-grunge");
  const auth = useMatrixAuth();

  // Apply theme to body so it persists across all game screens
  useEffect(() => {
    document.body.className = theme;
  }, [theme]);

  // Clear resume data on the main page so players aren't trapped in a stale game
  useEffect(() => {
    if (mode === "choose") clearResume();
  }, [mode]);

  if (mode === "solo") return <SoloGame />;
  if (mode === "multiplayer") return <MultiplayerGame joinGameId={joinGameId} matrixDisplayName={auth.user?.displayName ?? auth.user?.userId} />;

  return (
    <div className="app">
      <div className="start-screen">
        <div className="start-glow" aria-hidden="true" />
        <h1>raising intelligences</h1>
        <p className="dim">{TAGLINE}</p>
        <div className="auth-chip">
          {auth.loggedIn ? (
            <>
              <span className="auth-name">{auth.user?.displayName ?? auth.user?.userId}</span>
              <button className="auth-link" onClick={() => auth.logout()}>sign out</button>
            </>
          ) : (
            <button className="auth-link" onClick={() => auth.showLoginModal()}>sign in</button>
          )}
        </div>
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
