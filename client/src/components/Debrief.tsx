import type { ReactNode } from "react";

interface Props {
  onContinue: () => void;
  extraButton?: ReactNode;
  /**
   * The child's own first-person memory of the scene. Plain text. Empty renders
   * nothing at all, not a placeholder.
   */
  memorySummary?: string;
  /** The player's own answer to "what did you hope they'd take", if they gave one. */
  hoped?: string;
}

export function Debrief({ onContinue, extraButton, memorySummary = "", hoped }: Props) {
  const kept = memorySummary.trim();
  const hopedText = hoped?.trim();
  return (
    <div className="debrief-enhanced">
      <div className="debrief-text-block">
        <p className="debrief-line-1">time passed</p>
        <p className="debrief-line-2">they are a little different now</p>
      </div>
      {(kept || hopedText) && (
        <div className="debrief-kept" data-testid="debrief-kept">
          {hopedText && (
            <div className="debrief-kept-item">
              {/* COPY: pending Liz review */}
              <p className="debrief-kept-label">what you hoped</p>
              <p className="debrief-kept-text" data-testid="debrief-hoped">{hopedText}</p>
            </div>
          )}
          {kept && (
            <div className="debrief-kept-item">
              {/* COPY: pending Liz review */}
              <p className="debrief-kept-label">what stayed with them</p>
              <p className="debrief-kept-text" data-testid="debrief-memory">{kept}</p>
            </div>
          )}
        </div>
      )}
      <button onClick={onContinue} className="btn" data-testid="btn-next-event">
        next event
      </button>
      {extraButton}
    </div>
  );
}
