import { useState, useEffect } from "react";
import { ChildPortrait } from "./ChildPortrait";

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

interface Props {
  childName: string;
  gameId: string | null;
  eventReady: boolean;
  onReady: () => void;
}

export function GuardianScreen({ childName, gameId, eventReady, onReady }: Props) {
  const [fragmentIdx, setFragmentIdx] = useState(0);
  const [portraitReady, setPortraitReady] = useState(false);

  useEffect(() => {
    if (portraitReady) return;
    const id = setInterval(() => {
      setFragmentIdx((i) => (i + 1) % FRAGMENTS.length);
    }, 2600);
    return () => clearInterval(id);
  }, [portraitReady]);

  const canBegin = portraitReady && eventReady;

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

      {portraitReady && (
        <div className="guardian-revealed-text">
          <p>three years old.</p>
          <p>they need you.</p>
        </div>
      )}

      {portraitReady && !eventReady && (
        <div className="guardian-event-loading">
          <span className="event-spinner" aria-hidden="true" />
        </div>
      )}

      <button
        className="btn"
        onClick={onReady}
        disabled={!canBegin}
      >
        {!portraitReady
          ? "meeting them…"
          : !eventReady
          ? "entering their world…"
          : "I'm ready"}
      </button>
    </div>
  );
}
