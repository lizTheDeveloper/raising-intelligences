interface Props {
  text: string;
  onContinue: () => void;
}

/**
 * Dark Play Plan 3, Rung 3 — a child-welfare (CPS) determination. Same
 * read-and-advance shape as ConsultScreen, framed more formally since this
 * is the highest-stakes rung on the ladder. If the determination was
 * "removal" the server's /end-cps response carries phase "epilogue" (plus
 * the generated epilogue text) and SoloGame routes to the existing Endgame
 * screen instead of back here — this component only ever renders the
 * determination text itself.
 */
export function CpsScreen({ text, onContinue }: Props) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="intervention-screen cps-screen">
      <p className="intervention-label">child welfare determination</p>
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
      <button onClick={onContinue} className="btn" data-testid="btn-cps-continue">
        continue
      </button>
    </div>
  );
}
