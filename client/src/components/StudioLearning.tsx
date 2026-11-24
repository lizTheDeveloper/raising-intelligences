import { useEffect, useState } from "react";
import { LEARNING_ANSWERS, LEARNING_EXPLAINS, LEARNING_NOTED, LEARNING_QUESTION } from "../shareCodes";

/**
 * Host tools studio learning (spec §B.4/§B.5, H18), after the share step at
 * studio events that offer it. The reply is the same whatever was chosen, and
 * the co-parent is never told. Nothing on this screen is tracked.
 */

interface Props {
  view: { answered: boolean } | null;
  error: string | null;
  onAnswer: (answer: "yes" | "no" | "status") => void;
}

export function StudioLearning({ view, error, onAnswer }: Props) {
  const [sent, setSent] = useState(false);

  // Where this seat stands (a reload of the end screen).
  useEffect(() => onAnswer("status"), [onAnswer]);
  // Any answer back from the server gives the buttons back.
  useEffect(() => setSent(false), [view, error]);

  if (!view) {
    return (
      <div className="lobby stranger-mode event-card share-step" role="status">
        {error ? <p className="error">{error}</p> : <p className="dim">one moment…</p>}
      </div>
    );
  }

  if (view.answered) {
    return (
      <div className="lobby stranger-mode event-card share-step" role="status" data-testid="learning-answered">
        <p>{LEARNING_NOTED}</p>
      </div>
    );
  }

  // H20: two equal buttons, neither pre-selected, focused or styled as the default.
  return (
    <div className="lobby stranger-mode event-card share-step" data-testid="studio-learning">
      <h2><strong>{LEARNING_QUESTION}</strong></h2>
      <p>{LEARNING_EXPLAINS}</p>
      <div className="event-card-actions share-answers">
        {LEARNING_ANSWERS.map((a) => (
          <button
            key={a.answer}
            className="btn btn-secondary"
            onClick={() => { setSent(true); onAnswer(a.answer); }}
            disabled={sent}
            data-testid={`btn-learning-${a.answer}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
