import { useState, useEffect } from "react";
import { ChildPortrait } from "./ChildPortrait";
import { track } from "../analytics";

const FRAGMENTS = [
  "they took their first steps.",
  "they said your name.",
  "they asked why things are the way they are.",
  "they laughed at something small.",
  "they fell asleep in the car on the way home.",
  "they scraped their knee and looked to you first.",
  "they reached for your hand.",
  "they're already becoming someone.",
];

const CHILD_THOUGHTS = [
  "why is the sky so big?",
  "can i have juice?",
  "where did the moon go?",
  "i'm not tired.",
  "what's that sound?",
  "i made a friend today.",
  "i don't like carrots but i like cake.",
  "why do you have to leave?",
];

interface Props {
  childName: string;
  gameId: string | null;
  eventReady: boolean;
  onReady: () => void;
}

export function GuardianScreen({ childName, gameId, eventReady, onReady }: Props) {
  const [fragmentIdx, setFragmentIdx] = useState(0);
  const [thoughtIdx, setThoughtIdx] = useState(0);
  const [portraitReady, setPortraitReady] = useState(false);
  const [showMessage, setShowMessage] = useState(false);

  useEffect(() => {
    if (portraitReady) return;
    const id = setInterval(() => {
      setFragmentIdx((i) => (i + 1) % FRAGMENTS.length);
    }, 2600);
    return () => clearInterval(id);
  }, [portraitReady]);

  useEffect(() => {
    if (eventReady) return;
    const id = setInterval(() => {
      setThoughtIdx((i) => (i + 1) % CHILD_THOUGHTS.length);
    }, 2000);
    return () => clearInterval(id);
  }, [eventReady]);

  const handleNotReady = () => {
    setShowMessage(true);
    // Brief delay to show the message before transitioning
    setTimeout(() => {
      track("guardian_not_ready");
      onReady();
    }, 1500);
  };

  const canBegin = eventReady && !showMessage;

  return (
    <div className="guardian-screen">
      <h2 className="guardian-name">{childName}</h2>

      <div className="guardian-figure">
        {/* Portrait fades in once ready; fragments show until then */}
        <div className={`guardian-portrait-wrap${portraitReady ? " guardian-portrait-revealed" : ""}`}>
          <ChildPortrait age={3} size={200} gameId={gameId} onLoad={() => setPortraitReady(true)} />
        </div>

        {!portraitReady && (
          <div className="guardian-fragments">
            <span key={fragmentIdx} className="guardian-fragment">
              {FRAGMENTS[fragmentIdx]}
            </span>
          </div>
        )}
      </div>

      {portraitReady && !eventReady && (
        <>
          <div className="guardian-revealed-text">
            <p>three years old.</p>
            <p>they need you.</p>
          </div>
          <div className="guardian-thoughts">
            <span key={thoughtIdx} className="guardian-thought">
              {CHILD_THOUGHTS[thoughtIdx]}
            </span>
          </div>
        </>
      )}

      {eventReady && (
        <div className="guardian-buttons">
          <button
            className="btn"
            onClick={() => { track("guardian_accepted"); onReady(); }}
          >
            I'm ready
          </button>
          <button
            className="btn dim"
            onClick={handleNotReady}
          >
            I'm not ready
          </button>
        </div>
      )}

      {showMessage && (
        <p className="guardian-not-ready-message">most people aren't</p>
      )}
    </div>
  );
}
