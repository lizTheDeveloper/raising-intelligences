import "../styles/endgame.css";
import { SupportPrompt } from "./SupportPrompt";
import { Credits } from "./Credits";
import { FollowupOffer } from "./FollowupOffer";

interface Props {
  epilogue: string;
  onContinue: () => void;
  /** Solo games only: passing it enables the optional follow-up offer (itself hidden unless research is available). */
  followupGameId?: string | null;
}

/** The follow-up ask lands after the support prompt (+500ms) and before continue (+900ms). */
const FOLLOWUP_DELAY_MS = 700;

export function Endgame({ epilogue, onContinue, followupGameId }: Props) {
  const paragraphs = epilogue
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  // The support prompt fades in once the last paragraph has landed, and the
  // continue button waits a beat past that — reading the epilogue and the
  // quiet ask both come before "what next".
  const lastParaDelay = paragraphs.length * 420;

  return (
    <div className="endgame">
      <p className="endgame-label">years later</p>
      <div className="epilogue-body">
        {paragraphs.map((para, i) => (
          <p
            key={i}
            className={`epilogue-para${i === 0 ? " epilogue-para-lead" : ""}`}
            style={{ animationDelay: `${i * 420}ms` }}
          >
            {para}
          </p>
        ))}
      </div>
      <SupportPrompt sourcePage="epilogue" style={{ animationDelay: `${lastParaDelay + 500}ms` }} />
      {followupGameId ? <FollowupOffer gameId={followupGameId} style={{ animationDelay: `${lastParaDelay + FOLLOWUP_DELAY_MS}ms` }} /> : null}
      <div className="endgame-actions">
        <button
          onClick={onContinue}
          className="btn"
          data-testid="btn-continue"
          style={{ animationDelay: `${lastParaDelay + 900}ms` }}
        >
          continue
        </button>
      </div>
      <Credits variant="endgame" style={{ animationDelay: `${lastParaDelay + 1300}ms` }} />
    </div>
  );
}
