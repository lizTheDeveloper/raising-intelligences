import type { HostTerms } from "../hostInvite";

/**
 * The host and guest-reader terms, before a person's portal opens (persona
 * tests, S2-5). The version they agree to is what's recorded against them.
 */
export function HostTermsView({ terms, busy, error, onAgree, children }: {
  terms: HostTerms;
  busy: boolean;
  error: string | null;
  onAgree: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="lobby stranger-mode event-card host-portal host-terms" data-testid="host-terms">
      <h1>the host terms</h1>
      <p className="dim">before your page opens, please read what hosts and guest readers agree to. this is what's recorded as your agreement.</p>
      {terms.sections.map((s) => (
        <section key={s.heading} className="event-card-section">
          <h2>{s.heading}</h2>
          <ul>{s.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
        </section>
      ))}
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={onAgree} disabled={busy} data-testid="btn-host-terms-agree">
        {busy ? "saving…" : "I agree"}
      </button>
      {children}
    </div>
  );
}
