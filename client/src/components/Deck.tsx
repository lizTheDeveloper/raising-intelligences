import { asDeck, type Deck as DeckData } from "../hostPortal";

/**
 * The RI discussion deck (host tools spec §B.6): static questions from the
 * studio, no player data. Printable. Reached from the host portal and alone at
 * `?deck=1` with no sign-in. Nothing here is tracked.
 */

const API = import.meta.env.BASE_URL + "api";

/**
 * GET /events/deck. Anything but a 200 with a deck is null: host tools are
 * off, and the caller shows the normal app as if no parameter was given.
 */
export async function loadDeck(): Promise<DeckData | null> {
  try {
    const res = await fetch(`${API}/events/deck`);
    if (res.status !== 200) return null;
    return asDeck(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

export function Deck({ deck, onBack }: { deck: DeckData; onBack: () => void }) {
  return (
    <div className="lobby stranger-mode event-card deck" data-testid="deck">
      <h1>{deck.title}</h1>
      <p className="dim">{deck.intro}</p>
      <ol className="deck-questions">
        {deck.questions.map((q, i) => <li key={i}>{q}</li>)}
      </ol>
      <div className="event-card-actions no-print">
        <button className="btn" onClick={() => window.print()}>print</button>
        <button className="btn btn-secondary" onClick={onBack}>back</button>
      </div>
    </div>
  );
}
