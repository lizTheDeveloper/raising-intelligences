import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { REPAIR_MAX_LENGTH, type RepairResult } from "../repairClient";

interface Props {
  /** `repaired` is true only when the player went back to the moment first. */
  onContinue: (repaired?: boolean) => void;
  /**
   * Optional. Sends what the parent said to the child. "failed" means it did
   * not go through; "ended" means the session was ended (the parent screen
   * changes, so nothing more is done here). Absent means the control is not offered.
   */
  onRepair?: (message: string) => Promise<RepairResult>;
  extraButton?: ReactNode;
  /**
   * The child's own first-person memory of the scene. Plain text. Empty renders
   * nothing at all, not a placeholder.
   */
  memorySummary?: string;
  /** The player's own answer to "what did you hope they'd take", if they gave one. */
  hoped?: string;
}

export function Debrief({ onContinue, onRepair, extraButton, memorySummary = "", hoped }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Set once the player has pressed continue, so a repair that finishes later
  // never starts a second continue.
  const continued = useRef(false);
  const fieldId = useId();

  // Focus follows the control: into the box when it opens, back to the
  // toggle when it closes.
  useEffect(() => {
    if (open) fieldRef.current?.focus();
    else if (wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const send = async () => {
    const message = text.trim();
    if (!onRepair || !message || sending) return;
    setSending(true);
    setFailed(false);
    let result: RepairResult = "failed";
    try {
      result = await onRepair(message);
    } catch {
      result = "failed";
    }
    setSending(false);
    if (continued.current || result === "ended") return;
    if (result === "sent") {
      continued.current = true;
      onContinue(true);
    } else {
      setFailed(true);
    }
  };
  const continueNow = () => {
    if (continued.current) return;
    continued.current = true;
    onContinue();
  };

  const kept = memorySummary.trim();
  const hopedText = hoped?.trim();
  return (
    <div className="debrief-enhanced">
      <div className="debrief-text-block">
        <p className="debrief-line-1">time passed</p>
        <p className="debrief-line-2">they are a little different now</p>
      </div>
      {(kept || hopedText) && (
        <div
          className="debrief-kept"
          data-testid="debrief-kept"
          role="region"
          tabIndex={0}
          /* Scrolls when long, so it must be reachable by keyboard. COPY: pending Liz review */
          aria-label="what stayed with them, and what you hoped"
        >
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
      {onRepair && (
        <div className="debrief-repair">
          {!open ? (
            <button
              ref={toggleRef}
              type="button"
              className="btn btn-secondary debrief-repair-toggle"
              data-testid="btn-repair-open"
              onClick={() => setOpen(true)}
            >
              {/* COPY: pending Liz review */}
              go back to that moment
            </button>
          ) : (
            <form
              className="debrief-repair-form"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {/* COPY: pending Liz review */}
              <label htmlFor={fieldId} className="debrief-kept-label">
                something you wish you had said
              </label>
              <textarea
                id={fieldId}
                ref={fieldRef}
                className="debrief-repair-input"
                data-testid="repair-input"
                maxLength={REPAIR_MAX_LENGTH}
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={sending}
                aria-describedby={failed ? `${fieldId}-note` : undefined}
              />
              {failed && (
                <p id={`${fieldId}-note`} role="status" className="debrief-repair-note" data-testid="repair-failed">
                  {/* COPY: pending Liz review */}
                  it did not reach them. you can keep going without it.
                </p>
              )}
              <div className="debrief-repair-actions">
                <button type="submit" className="btn btn-secondary" data-testid="btn-repair-send" disabled={sending || !text.trim()}>
                  {/* COPY: pending Liz review */}
                  say it
                </button>
                <button type="button" className="btn btn-secondary" data-testid="btn-repair-cancel" onClick={() => setOpen(false)}>
                  {/* COPY: pending Liz review */}
                  never mind
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      <button onClick={continueNow} className="btn" data-testid="btn-next-event">
        next event
      </button>
      {extraButton}
    </div>
  );
}
