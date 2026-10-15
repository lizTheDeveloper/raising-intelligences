import { useEffect } from "react";
import { track } from "../analytics";

/**
 * Direct Stripe payment link for this game (pay-what-you-want, $20 minimum as
 * an anti card-testing floor). The button is a plain link: one click, straight
 * to Stripe, nothing in between that can break. The server's
 * /api/support/checkout proxy still exists but the prompt no longer depends on
 * it — that path was 2 clicks plus a server round-trip, and it went silently
 * dead once already (see server/src/routes/support.ts).
 */
const STRIPE_URL = "https://buy.stripe.com/bJe3cucbgfaH1db9Gh6c00p";
/** Smaller amounts go to Patreon. */
const PATREON_URL = "https://www.patreon.com/lizthedeveloper";

interface Props {
  /** Where in the game this prompt is shown, for attribution — e.g. "epilogue". */
  sourcePage: string;
  style?: React.CSSProperties;
}

/**
 * A quiet, easy-to-ignore "pay what you can" ask. No modal, no hard sell —
 * just a line of text and a link straight to Stripe (or Patreon for any amount). Meant
 * for the epilogue, right after the "years later" narrative lands, before
 * the reader clicks continue.
 */
export function SupportPrompt({ sourcePage, style }: Props) {
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

  return (
    <div className="support-prompt" style={style}>
      <p className="support-line">
        Raising Intelligences is free, and always will be. If it meant something to you,
        you're welcome to leave something for the people who made it.
      </p>
      <div className="support-amounts">
        <a
          className="btn-link support-amount"
          href={STRIPE_URL}
          target="_blank"
          rel="noopener"
          onClick={() => {
            // Analytics only — never preventDefault; the link does the navigating.
            track("support_clicked", { sourcePage });
            track("checkout_started", { provider: "stripe", sourcePage });
          }}
          data-testid="btn-support-stripe"
        >
          Support $20+
        </a>
        <a
          className="btn-link support-amount"
          href={PATREON_URL}
          target="_blank"
          rel="noopener"
          onClick={() => track("checkout_started", { provider: "patreon", sourcePage })}
          data-testid="btn-support-patreon"
        >
          or any amount on Patreon
        </a>
      </div>
    </div>
  );
}
