import { ChildPortrait } from "./ChildPortrait";
import { ChildPresence } from "./ChildPresence";

interface Props {
  event: { age: number; description: string } | null;
  onReady: () => void;
  waiting: boolean;
  gameId?: string | null;
}

export function EventIntro({ event, onReady, waiting, gameId }: Props) {
  if (waiting) {
    return (
      <div className="event-intro">
        <ChildPresence age={event?.age ?? 3} size={90} />
        <p className="dim">generating next event...</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="event-intro">
        <ChildPresence age={0} size={90} />
        <button onClick={onReady} className="btn">
          begin
        </button>
      </div>
    );
  }

  return (
    <div className="event-intro">
      <div className="event-intro-figure">
        <ChildPortrait age={event.age} size={180} gameId={gameId} />
      </div>
      <p className="age-marker">— age {event.age} —</p>
      <p className="event-description">{event.description}</p>
      <button onClick={onReady} className="btn">
        enter
      </button>
    </div>
  );
}
