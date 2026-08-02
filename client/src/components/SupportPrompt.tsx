import { useState, useEffect } from "react";
import { track } from "../analytics";

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

  /**
   * Stage 1 of the canonical revenue funnel. This component had no analytics
   * at all — the flagship title, 335 visitors, contributing zero rows to the
   * studio's money path — while already receiving a `sourcePage` prop built
   * for exactly this attribution and throwing it away.
   *
   * In an effect so it means "the ask was rendered", and deduped per
   * sourcePage per session inside analytics.ts so a re-render or a second look
   * at the epilogue cannot inflate the impression count.
   */
  useEffect(() => {
    track("support_prompt_shown", { sourcePage, reachedEnding: sourcePage === "epilogue" });
  }, [sourcePage]);

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
        // Stage 5 — the last client-side event before Stripe takes the page.
        // Fired before the redirect, because after it there is no page left.
        track("checkout_started", { amount: cents, sourcePage });
        window.location.href = data.url;
        return;
      }
      throw new Error("checkout failed");
    } catch {
      // The catch used to swallow the failure into a UI string and nothing
      // else, so a broken money path looked exactly like nobody paying.
      track("error_occurred", { step: "support_checkout", amount: cents, sourcePage });
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
        <button
          className="btn-link"
          onClick={() => {
            // Stage 2 — intent. Isolates "the ask was never seen" from
            // "the ask was seen and declined".
            track("support_clicked", { sourcePage });
            setExpanded(true);
          }}
          data-testid="btn-support-expand"
        >
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
