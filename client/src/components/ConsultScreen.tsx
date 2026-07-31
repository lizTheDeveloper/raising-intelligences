interface Props {
  text: string;
  onContinue: () => void;
}

/**
 * Dark Play Plan 3, Rung 1 — a school/pediatric consult. Read-and-advance,
 * mirroring Debrief.tsx: render the generated psychologist text as
 * paragraphs, then a single button to move on.
 */
export function ConsultScreen({ text, onContinue }: Props) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="intervention-screen consult-screen">
      <p className="intervention-label">the psychologist speaks</p>
      <div className="intervention-text-block">
        {paragraphs.length > 0 ? (
          paragraphs.map((para, i) => (
            <p key={i} className="intervention-para">
              {para}
            </p>
          ))
        ) : (
          <p className="intervention-para dim">...</p>
        )}
      </div>
      <button onClick={onContinue} className="btn" data-testid="btn-consult-continue">
        continue
      </button>
    </div>
  );
}
