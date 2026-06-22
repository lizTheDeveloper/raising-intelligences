interface Props {
  onContinue: () => void;
}

export function Debrief({ onContinue }: Props) {
  return (
    <div className="debrief">
      <p className="dim">time passed. they are a little different now.</p>
      <button onClick={onContinue} className="btn">
        next event
      </button>
    </div>
  );
}
