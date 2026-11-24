/**
 * The host portal's share codes section (spec §B.5). Entering a code arrives
 * with the next update (redeem and view); until then this is the notice and a
 * placeholder. Kept separate so that update can replace it whole.
 */
export function HostCodes(_props: { pass: string; onSignedOut: () => void }) {
  return (
    <section className="event-card-section host-codes" data-testid="host-codes">
      <h2>share codes</h2>
      <p>RI never shows you who played or who made a code. please don't ask anyone whether they made one.</p>
      <p className="dim" aria-disabled="true">entering codes arrives in the next update.</p>
    </section>
  );
}
