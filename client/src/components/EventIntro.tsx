interface Props {
  event: { age: number; description: string } | null;
  onReady: () => void;
  waiting: boolean;
}

export function EventIntro({ event, onReady, waiting }: Props) {
  if (waiting) {
    return (
      <div className="event-intro">
        <p className="dim">generating next event...</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="event-intro">
        <button onClick={onReady} className="btn">
          begin
        </button>
      </div>
    );
  }

  return (
    <div className="event-intro">
      <p className="age-marker">— age {event.age} —</p>
      <p className="event-description">{event.description}</p>
      <button onClick={onReady} className="btn">
        enter
      </button>
    </div>
  );
}
