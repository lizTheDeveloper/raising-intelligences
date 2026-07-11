import "../styles/endgame.css";
import { SupportPrompt } from "./SupportPrompt";

interface Props {
  epilogue: string;
  onContinue: () => void;
}

export function Endgame({ epilogue, onContinue }: Props) {
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
    </div>
  );
}
