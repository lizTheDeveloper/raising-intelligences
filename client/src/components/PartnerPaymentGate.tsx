import { useState } from "react";
import { track } from "../analytics";

const API = import.meta.env.BASE_URL + "api";

interface Props {
  gameId: string;
  childName: string;
  /** The host (parent1) pays; the partner waits. */
  youPay: boolean;
  amountCents: number;
  hostName: string;
  partnerName: string;
  /** The host's reconnect token — proves this browser holds the host seat. */
  playerToken: () => string | null;
  onLeave: () => void;
}

/**
 * The $20 per-child step: shown once the partner has really joined (both
 * parents' answers are in) and before anything is generated for the child.
 * The host goes to Stripe Checkout and comes back to the same game.
 */
export function PartnerPaymentGate({ gameId, childName, youPay, amountCents, hostName, partnerName, playerToken, onLeave }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dollars = `$${(amountCents / 100).toFixed(amountCents % 100 === 0 ? 0 : 2)}`;
  const name = childName || "your child";

  const pay = async () => {
    setBusy(true);
    setError(null);
    track("partner_payment_started");
    try {
      const res = await fetch(`${API}/partner-payment/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, playerToken: playerToken() }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string; alreadyPaid?: boolean };
      if (res.ok && body.url) {
        window.location.assign(body.url);
        return;
      }
      if (body.alreadyPaid) {
        setError("this child is already paid for. one moment…");
      } else {
        setError(body.error ?? "checkout didn't open. try again.");
      }
    } catch {
      setError("checkout didn't open. try again.");
    }
    setBusy(false);
  };

  if (!youPay) {
    return (
      <div className="lobby partner-payment" role="status" aria-live="polite">
        <h1>raising {name}</h1>
        <p className="dim">
          {hostName} is finishing setting up {name}. they cover partner play, so there is nothing for you to pay.
        </p>
        <p className="dim">you'll go straight into the story when they're done.</p>
        <button className="btn btn-secondary" onClick={onLeave} style={{ marginTop: 12 }}>
          leave game
        </button>
      </div>
    );
  }

  return (
    <div className="lobby partner-payment">
      <h1>raising {name}</h1>
      <p>{partnerName} is here, and both of you have answered.</p>
      <p className="dim">
        raising a child with a partner is {dollars}, once, for this child. nothing has been charged yet.
        it covers the whole childhood, and it pays for many free solo childhoods too.
      </p>
      <p className="dim">solo play stays free, always.</p>
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={pay} disabled={busy} data-testid="btn-partner-pay">
        {busy ? "opening checkout…" : `pay ${dollars} and begin`}
      </button>
      <button className="btn btn-secondary" onClick={onLeave} style={{ marginTop: 12 }}>
        not now
      </button>
    </div>
  );
}
