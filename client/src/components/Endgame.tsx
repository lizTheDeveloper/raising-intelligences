import "../styles/endgame.css";

interface Props {
  epilogue: string;
  onContinue: () => void;
}

export function Endgame({ epilogue, onContinue }: Props) {
  const paragraphs = epilogue
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="endgame">
      <p className="endgame-label">years later</p>
      <div className="epilogue-body">
        {paragraphs.map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
      <div className="endgame-actions">
        <button onClick={onContinue} className="btn">
          continue
        </button>
      </div>
    </div>
  );
}
