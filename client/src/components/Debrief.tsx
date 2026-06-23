import type { ReactNode } from "react";

interface Props {
  onContinue: () => void;
  extraButton?: ReactNode;
}

export function Debrief({ onContinue, extraButton }: Props) {
  return (
    <div className="debrief-enhanced">
      <div className="debrief-text-block">
        <p className="debrief-line-1">time passed</p>
        <p className="debrief-line-2">they are a little different now</p>
      </div>
      <button onClick={onContinue} className="btn" data-testid="btn-next-event">
        next event
      </button>
      {extraButton}
    </div>
  );
}
