import { useEffect, useState } from "react";
import type { Question, WaitKind } from "../researchTypes";
import { useWaitQuestions } from "../hooks/useWaitQuestions";

interface CardProps {
  question: Question | null;
  onAnswer: (answer: unknown) => void;
  onSkip: () => void;
}

/** How long the card takes to fade after its question goes away. Matches the CSS. */
const FADE_MS = 400;
/** Input is ignored this long after a card appears. */
const ARM_MS = 350;

/**
 * One question, offered during a wait. Quiet by design: it sits under the
 * spinner or the fragment, never takes focus on its own, and "skip" is always
 * there. When `question` becomes null the last card fades out rather than
 * vanishing, then unmounts.
 */
export function WaitQuestionCard({ question, onAnswer, onSkip }: CardProps) {
  // Keep the last question around for the fade-out.
  const [shown, setShown] = useState<Question | null>(question);
  const [text, setText] = useState("");
  // A new card ignores input briefly, so the second click of a double-click on
  // the previous card cannot land on this one.
  const [armed, setArmed] = useState(true);

  // Adopt a new question during render, not in an effect: an effect leaves one
  // render where the OLD card's buttons are live but `onAnswer` already points
  // at the NEW question, and a click in that gap would answer the wrong one.
  if (question && question !== shown) {
    setShown(question);
    setText("");
    setArmed(false);
  }
  const leaving = question === null;

  useEffect(() => {
    if (question) {
      const id = setTimeout(() => setArmed(true), ARM_MS);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setShown(null), FADE_MS);
    return () => clearTimeout(id);
  }, [question]);

  if (!shown) return null;
  const spec = shown.answer;
  const promptId = `wait-q-${shown.id}`;
  // Once leaving, the buttons stop doing anything; the hook has already moved on.
  const live = !leaving && armed && shown === question;

  return (
    <div
      className={`wait-card${leaving ? " wait-card-leaving" : ""}`}
      key={shown.id}
      role="group"
      aria-labelledby={promptId}
      data-testid="wait-question-card"
    >
      <p className="wait-card-prompt" id={promptId} aria-live="polite">
        {shown.prompt}
      </p>
      {spec.type === "tap" ? (
        <div className="wait-card-options">
          {spec.options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="btn dim wait-card-option"
              aria-disabled={!live}
              onClick={() => live && onAnswer(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="wait-card-text">
          <textarea
            className="wait-card-input"
            aria-labelledby={promptId}
            rows={3}
            maxLength={spec.maxLength}
            value={text}
            readOnly={!live}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            className="btn dim"
            disabled={text.trim().length === 0}
            aria-disabled={!live}
            onClick={() => live && onAnswer(text)}
          >
            {/* COPY: pending Liz review */}
            send
          </button>
        </div>
      )}
      <button type="button" className="wait-card-skip" aria-disabled={!live} onClick={() => live && onSkip()}>
        {/* COPY: pending Liz review */}
        skip
      </button>
    </div>
  );
}

/**
 * The hook and the card together, for places that just want "questions while
 * this wait lasts". Mount it for the duration of the wait, or flip `active`;
 * either way the card is gone when the wait is.
 */
export function WaitQuestions({
  gameId,
  wait,
  sceneIndex,
  active = true,
}: {
  gameId: string | null | undefined;
  wait: WaitKind;
  sceneIndex: number;
  active?: boolean;
}) {
  const { current, submit, skip } = useWaitQuestions(gameId ?? null, wait, sceneIndex, active);
  // The fade is for card-to-card changes and a finished queue. A wait that has
  // ended removes the card outright, with no fade to linger through.
  if (!active) return null;
  return <WaitQuestionCard question={current} onAnswer={submit} onSkip={skip} />;
}
