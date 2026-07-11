import { useState } from "react";

const API = import.meta.env.BASE_URL + "api";

const AMOUNTS = [
  { cents: 300, label: "$3" },
  { cents: 700, label: "$7" },
  { cents: 1500, label: "$15" },
];

interface Props {
  /** Where in the game this prompt is shown, for attribution — e.g. "epilogue". */
  sourcePage: string;
  style?: React.CSSProperties;
}

/**
 * A quiet, easy-to-ignore "pay what you can" ask. No modal, no hard sell —
 * just a line of text and, if you want it, a couple of small amounts. Meant
 * for the epilogue, right after the "years later" narrative lands, before
 * the reader clicks continue.
 */
export function SupportPrompt({ sourcePage, style }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [loadingCents, setLoadingCents] = useState<number | null>(null);
  const [error, setError] = useState(false);

  async function support(cents: number) {
    setLoadingCents(cents);
    setError(false);
    try {
      const res = await fetch(`${API}/support/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: cents, sourcePage }),
      });
      const data = (await res.json()) as { url?: string };
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      throw new Error("checkout failed");
    } catch {
      setError(true);
      setLoadingCents(null);
    }
  }

  return (
    <div className="support-prompt" style={style}>
      <p className="support-line">
        Raising Intelligences is free, and always will be. If it meant something to you,
        you're welcome to leave a little for the people who made it.
      </p>
      {!expanded ? (
        <button className="btn-link" onClick={() => setExpanded(true)} data-testid="btn-support-expand">
          leave something
        </button>
      ) : (
        <div className="support-amounts">
          {AMOUNTS.map((a) => (
            <button
              key={a.cents}
              className="btn-link support-amount"
              disabled={loadingCents !== null}
              onClick={() => support(a.cents)}
              data-testid={`btn-support-${a.cents}`}
            >
              {loadingCents === a.cents ? "…" : a.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="support-error">Couldn't reach checkout — maybe another time.</p>}
    </div>
  );
}
