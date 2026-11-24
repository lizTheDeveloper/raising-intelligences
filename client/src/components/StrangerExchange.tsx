import { useEffect, useState } from "react";

/**
 * The one ending for every way the exchange doesn't happen — they said no,
 * never answered, a check refused it, a report. Nobody is told which.
 */
export const EXCHANGE_ENDING = "this one ends here. thanks for raising them together.";

export interface HandleState {
  mine: "yes" | "no" | null;
  closed: boolean;
  /** The OTHER player's Matrix id: only ever sent on a mutual yes. */
  matrixId?: string;
  error?: string;
}

/**
 * After the report card, in a stranger game only: would you like to stay in
 * touch? Nothing is shared unless both say yes, having read the notice. No
 * "match" screen, no profile: one Matrix handle each way, or nothing.
 */
export function HandleExchange({ state, onAnswer, onStatus }: { state: HandleState | null; onAnswer: (answer: "yes" | "no", ack: boolean) => void; onStatus: () => void }) {
  const [read, setRead] = useState(false);
  // Where this seat stands (a reload, or a reveal missed while away).
  useEffect(() => onStatus(), [onStatus]);

  if (state?.matrixId) {
    return (
      <div className="lobby stranger-mode handle-exchange" role="status">
        <h2>you both said yes</h2>
        <p>your co-parent is <strong>{state.matrixId}</strong> on Matrix.</p>
        <p>
          <a className="btn btn-secondary" href={`https://matrix.to/#/${encodeURIComponent(state.matrixId)}`} target="_blank" rel="noopener noreferrer">
            open in Matrix
          </a>
        </p>
        <p className="dim">they were given your handle too. nobody else was.</p>
      </div>
    );
  }
  if (state?.closed) {
    return (
      <div className="lobby stranger-mode handle-exchange" role="status">
        <p className="dim">{EXCHANGE_ENDING}</p>
      </div>
    );
  }
  if (state?.mine === "yes") {
    return (
      <div className="lobby stranger-mode handle-exchange" role="status" aria-live="polite">
        <p className="dim">you said yes. if your co-parent says yes too, you'll each see the other's multiversegames.ai username here. if not, nothing is shared, and they won't know you said yes. this can take a while.</p>
      </div>
    );
  }
  return (
    <div className="lobby stranger-mode handle-exchange">
      <h2>stay in touch?</h2>
      <p>if you both say yes, you'll each see the other's multiversegames.ai username. if either says no, nothing is shared, and neither of you learns what the other said.</p>
      <div className="safety-notice">
        <p><strong>before you say yes</strong></p>
        <ul>
          <li>you met this person in a game. you don't know them yet.</li>
          <li>keep your home address, workplace and money to yourself.</li>
          <li>if you meet in person, meet somewhere public and tell a friend where you'll be.</li>
          <li>you can block and report anyone on Matrix. you can report them here too.</li>
        </ul>
        <label>
          <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> i've read this
        </label>
      </div>
      {state?.error && <p className="error">{state.error}</p>}
      <button className="btn" disabled={!read} onClick={() => onAnswer("yes", true)}>yes, share my handle</button>
      <button className="btn btn-secondary" onClick={() => onAnswer("no", false)} style={{ marginTop: 12 }}>no thanks</button>
    </div>
  );
}

/** A report, any time in a stranger game. Closes the handle exchange for good. */
export function StrangerReport({ reported, onReport }: { reported: boolean; onReport: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (reported) {
    return <p className="dim stranger-report" role="status">reported. thank you. nothing will be shared with them, and you won't be paired again.</p>;
  }
  if (!open) {
    return (
      <button className="btn btn-secondary stranger-report" onClick={() => setOpen(true)} data-testid="btn-stranger-report">
        report this co-parent
      </button>
    );
  }
  return (
    <form
      className="stranger-report"
      onSubmit={(e) => {
        e.preventDefault();
        onReport(reason);
      }}
    >
      <label className="dim" htmlFor="stranger-report-reason">what happened? (a person reads every report)</label>
      <textarea id="stranger-report-reason" className="name-input" maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn" type="submit">send report</button>
      <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>cancel</button>
    </form>
  );
}

/**
 * A stranger game that has ended. The same words for every cause; the
 * reporter (who knows why) also gets their report's confirmation.
 */
export function StrangerGameEnded({ reported, onLeave }: { reported: boolean; onLeave: () => void }) {
  return (
    <div className="lobby stranger-mode" role="status">
      <h2>the end of this story</h2>
      <p>{EXCHANGE_ENDING}</p>
      {reported && <p className="dim">your report was sent. a person reads every one. you won't be paired with them again, and nothing about you was shared.</p>}
      <button className="btn" onClick={onLeave}>back to the start</button>
    </div>
  );
}
