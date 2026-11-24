import { useState } from "react";
import {
  ackBody,
  asCard,
  boldRuns,
  currentStrangerPass,
  safeHttpsUrl,
  saveAck,
  statusNote,
  type MeetupCard,
} from "../meetupCard";

/**
 * The meetup event card (host tools spec §3.2), shown first on `?meetup=`.
 *
 * Nothing on this screen, the report form or "not for me" is tracked: no
 * track() calls, no Umami events (the card itself says "nothing on this page
 * is counted"). The meetup code only goes to this server's own /events routes.
 */

const API = import.meta.env.BASE_URL + "api";

export const CARD_CHANGED = "this meetup's card changed. here's the new one.";

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** Card text: `**bold**` becomes <strong>; everything else is plain (escaped) text. */
export function CardText({ text }: { text: string }) {
  return (
    <>
      {boldRuns(text).map((r, i) => (r.bold ? <strong key={i}>{r.text}</strong> : <span key={i}>{r.text}</span>))}
    </>
  );
}

interface Props {
  card: MeetupCard;
  meetup: string;
  /** Shown after a 409: the player acknowledged an older version. */
  changed?: boolean;
  /** The ack came back 409 with a newer card: show it, with the "changed" line. */
  onCardReplaced: (card: MeetupCard) => void;
  /** Acknowledged (and stored): go on to sign-in, or "get ready early". */
  onAcked: (prepareOnly: boolean) => void;
  onNotForMe: () => void;
  onInvite: () => void;
}

type View = "card" | "report" | "reported";

export function EventCard({ card, meetup, changed, onCardReplaced, onAcked, onNotForMe, onInvite }: Props) {
  const [view, setView] = useState<View>("card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState("");
  const host = card.hostName ?? "the host";
  const conduct = safeHttpsUrl(card.conductUrl);
  const note = statusNote(card.status);

  const acknowledge = async (prepareOnly: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ ackToken?: string; error?: string; card?: unknown }>(
        "/events/ack",
        ackBody(meetup, card.version, currentStrangerPass()),
      );
      if (r.status === 200 && r.body.ackToken) {
        saveAck({ ackToken: r.body.ackToken, version: card.version, ...(prepareOnly ? { prepareOnly: true } : {}) });
        onAcked(prepareOnly);
        return;
      }
      if (r.status === 409 && r.body.card) {
        const next = asCard(r.body.card);
        if (next) {
          onCardReplaced(next);
          window.scrollTo({ top: 0 });
          return;
        }
      }
      if (r.status === 404) return setError("this meetup isn't open anymore.");
      setError(r.body.error ?? "that didn't work. try again.");
    } catch {
      setError("that didn't work. try again.");
    } finally {
      setBusy(false);
    }
  };

  const sendReport = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!report.trim()) return setError("tell the studio what happened.");
    setBusy(true);
    try {
      const r = await post<{ ok?: boolean; error?: string }>("/events/report-host", { meetup, text: report });
      if (r.status === 200 && r.body.ok) {
        setReport("");
        setView("reported");
      } else {
        setError(r.body.error ?? "that didn't send. try again.");
      }
    } catch {
      setError("that didn't send. try again.");
    } finally {
      setBusy(false);
    }
  };

  const backToCard = () => { setError(null); setView("card"); };

  if (view === "reported") {
    return (
      <div className="lobby stranger-mode event-card" role="status">
        <p>thanks. the studio will look into it.</p>
        <button className="btn btn-secondary" onClick={backToCard}>back</button>
      </div>
    );
  }

  if (view === "report") {
    return (
      <div className="lobby stranger-mode event-card">
        <h1>report this host</h1>
        <p>tell the studio what happened. a person reads every report. {host} isn't told who sent it.</p>
        <form onSubmit={sendReport} className="event-card-report">
          <textarea
            className="event-card-textarea"
            aria-label="what happened"
            rows={6}
            maxLength={2000}
            value={report}
            onChange={(e) => setReport(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <button className="btn" type="submit" disabled={busy}>{busy ? "sending…" : "send"}</button>
        </form>
        <button className="btn btn-secondary" onClick={backToCard}>back</button>
      </div>
    );
  }

  return (
    <div className="lobby stranger-mode event-card" data-testid="event-card">
      {changed && <p className="event-card-changed" role="status">{CARD_CHANGED}</p>}
      <p className="event-card-lead dim"><strong>prototype</strong> · <CardText text={card.lead} /></p>
      <h1>{card.eventName}</h1>
      <p className="dim"><CardText text={card.hostLine} /></p>
      {card.welcome && <p><CardText text={card.welcome} /></p>}

      {card.sections.map((s, i) => (
        <section key={i} className="event-card-section">
          {s.heading && <h2><CardText text={s.heading} /></h2>}
          {s.paragraphs?.map((p, j) => <p key={j}><CardText text={p} /></p>)}
          {s.bullets && s.bullets.length > 0 && (
            <ul>{s.bullets.map((b, j) => <li key={j}><CardText text={b} /></li>)}</ul>
          )}
        </section>
      ))}

      <section className="event-card-section">
        <h2>came with someone you know?</h2>
        <p><CardText text={card.invite} /></p>
        <button className="btn btn-secondary" onClick={onInvite} disabled={busy} data-testid="btn-card-invite">
          start an invite game
        </button>
      </section>

      {note && <p className="event-card-note dim">{note}</p>}
      {error && <p className="error">{error}</p>}
      <div className="event-card-actions">
        <button className="btn" onClick={() => void acknowledge(false)} disabled={busy} data-testid="btn-card-continue">
          {busy ? "one moment…" : "sounds good, continue"}
        </button>
        <button className="btn btn-secondary" onClick={onNotForMe} disabled={busy} data-testid="btn-card-not-for-me">
          not for me
        </button>
      </div>
      <p className="event-card-links">
        <button className="btn-link" onClick={() => void acknowledge(true)} disabled={busy} data-testid="btn-card-ready">get ready early</button>
        {" · "}
        <button className="btn-link" onClick={() => { setError(null); setView("report"); }} data-testid="btn-card-report">report this host</button>
        {conduct && (
          <>
            {" · "}
            <a className="btn-link" href={conduct} target="_blank" rel="noopener noreferrer">code of conduct</a>
          </>
        )}
      </p>
    </div>
  );
}

/** "Not for me" (spec §3.3). The meetup is already gone from the URL and state. */
export function NotForMe({ lines, onSolo, onInvite }: { lines: string[]; onSolo: () => void; onInvite: () => void }) {
  return (
    <div className="lobby stranger-mode event-card">
      {lines.map((l, i) => <p key={i} className={i === 0 ? undefined : "dim"}><CardText text={l} /></p>)}
      <div className="event-card-actions">
        <button className="btn" onClick={onSolo}>play solo</button>
        <button className="btn btn-secondary" onClick={onInvite}>invite someone</button>
      </div>
    </div>
  );
}
