import { useState } from "react";
import { NEW_LINK_WARNING, asHostLink, type HostLink } from "../hostPortal";
import { asCard, type MeetupCard } from "../meetupCard";
import { CardTerms, CardText } from "./EventCard";

/**
 * A host's own meetup, in the portal (persona tests, Kofi): the link to hand
 * out, shown again whenever asked; the card exactly as players see it,
 * read-only; and "get a new link", which stops the old one at once. The link
 * lives only in this component's state (never storage, never the URL).
 */

const API = import.meta.env.BASE_URL + "api";
const TRY_AGAIN = "that didn't work. try again.";

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

interface Props {
  pass: string;
  eventRef: string;
  closed: boolean;
  onSignedOut: () => void;
}

export function HostEventLink({ pass, eventRef, closed, onSignedOut }: Props) {
  const [link, setLink] = useState<HostLink | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [card, setCard] = useState<MeetupCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ref = encodeURIComponent(eventRef);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError(TRY_AGAIN);
    } finally {
      setBusy(false);
    }
  };

  const show = () => run(async () => {
    const r = await post<{ error?: string }>(`/host/events/${ref}/link`, { pass });
    if (r.status === 401) return onSignedOut();
    const l = r.status === 200 ? asHostLink(r.body) : null;
    if (!l) return setError(r.body.error ?? TRY_AGAIN);
    setCopied(false);
    setLink(l);
  });

  const replace = () => run(async () => {
    const r = await post<{ error?: string }>(`/host/events/${ref}/new-link`, { pass });
    if (r.status === 401) return onSignedOut();
    const l = r.status === 200 ? asHostLink(r.body) : null;
    if (!l?.link) return setError(r.body.error ?? TRY_AGAIN);
    setConfirming(false);
    setCopied(false);
    setLink(l);
  });

  const preview = () => run(async () => {
    const r = await post<{ card?: unknown; error?: string }>(`/host/events/${ref}/card`, { pass });
    if (r.status === 401) return onSignedOut();
    const c = r.status === 200 ? asCard(r.body.card) : null;
    if (!c) return setError(r.body.error ?? TRY_AGAIN);
    setCard(c);
  });

  const copy = async () => {
    if (!link?.link) return;
    try {
      await navigator.clipboard.writeText(link.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (card) {
    return (
      <div className="host-card-preview" data-testid="host-card-preview">
        <p className="dim">this is the card your players see before they join. it's read-only here.</p>
        <div className="host-card-preview-body">
          <CardTerms card={card} headingLevel={2} />
          <section className="event-card-section">
            <h2>came with someone you know?</h2>
            <p><CardText text={card.invite} /></p>
          </section>
        </div>
        <button className="btn btn-secondary" onClick={() => setCard(null)}>back</button>
      </div>
    );
  }

  return (
    <div className="host-event-link" data-testid="host-event-link">
      {!closed && link?.link && (
        <div className="host-link-shown">
          <p>your meetup link:</p>
          <p className="host-link-text" data-testid="host-link-text">{link.link}</p>
          <div className="event-card-actions">
            <button className="btn btn-secondary" onClick={() => void copy()} disabled={busy}>{copied ? "copied" : "copy"}</button>
            <button className="btn btn-secondary" onClick={() => setLink(null)} disabled={busy}>hide</button>
          </div>
        </div>
      )}
      {!closed && link && !link.link && (
        <p className="dim" data-testid="host-link-none">this meetup's link was shown once, when it was made, and isn't kept. get a new link to see one here.</p>
      )}
      {!closed && confirming && (
        <div className="host-link-confirm" role="alertdialog" aria-label="get a new link">
          <p>{NEW_LINK_WARNING}</p>
          <div className="event-card-actions">
            <button className="btn" onClick={() => void replace()} disabled={busy} data-testid="btn-new-link-confirm">yes, get a new link</button>
            <button className="btn btn-secondary" onClick={() => setConfirming(false)} disabled={busy}>cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <p className="event-card-links">
        {!closed && !link?.link && (
          <><button className="btn-link" onClick={() => void show()} disabled={busy} data-testid="btn-show-link">show the meetup link</button>{" · "}</>
        )}
        {!closed && !confirming && (
          <><button className="btn-link" onClick={() => setConfirming(true)} disabled={busy} data-testid="btn-new-link">get a new link</button>{" · "}</>
        )}
        <button className="btn-link" onClick={() => void preview()} disabled={busy} data-testid="btn-card-preview">see the card your players see</button>
      </p>
    </div>
  );
}
