import "../styles/endgame.css";

interface Props {
  reportCard: string;
  childName: string;
}

type Block =
  | { kind: "h1" | "h2" | "h3" | "p"; text: string }
  | { kind: "bullet"; text: string };

/**
 * Lightweight inline markdown render — handles the heading levels and bullets
 * the report card prompt emits. No external markdown dependency.
 */
function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("### ")) {
      blocks.push({ kind: "h3", text: line.slice(4) });
    } else if (line.startsWith("## ")) {
      blocks.push({ kind: "h2", text: line.slice(3) });
    } else if (line.startsWith("# ")) {
      blocks.push({ kind: "h1", text: line.slice(2) });
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push({ kind: "bullet", text: line.slice(2) });
    } else {
      blocks.push({ kind: "p", text: line });
    }
  }
  return blocks;
}

export function ReportCard({ reportCard, childName }: Props) {
  const text = reportCard.trim()
    ? reportCard
    : `# ${childName}\n\nNo report card was generated.`;
  const blocks = parseBlocks(text);

  return (
    <div className="report-card">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "h1":
            return <h1 key={i}>{block.text}</h1>;
          case "h2":
            return <h2 key={i}>{block.text}</h2>;
          case "h3":
            return <h3 key={i}>{block.text}</h3>;
          case "bullet":
            return (
              <p key={i} className="rc-bullet">
                {block.text}
              </p>
            );
          default:
            return <p key={i}>{block.text}</p>;
        }
      })}
    </div>
  );
}
