import { useEffect, useState } from "react";
import {
  CARRIES_NOTHING,
  REPORT_CARD_OMITTED,
  SHARE_SILENCE,
  previewButton,
  previewTitle,
  shareExplains,
  shareQuestion,
  shareViewLine,
  snapshotBlocks,
  type ShareSnapshot,
  type ShareView,
} from "../shareCodes";

/**
 * Host tools share step (spec §5.1), after the report card in a stranger game
 * at a meetup with share codes. The same screens for every game, including
 * games that can never make a code. A code never appears here: only on the
 * account page. Nothing on this screen is tracked.
 */

export const ACCOUNT_HREF = `${import.meta.env.BASE_URL}?stranger=account`;

/**
 * "your account", in a new tab so the screen it's on (the end screen and the
 * handle exchange after it, or the queue) stays put. Host tools only.
 */
export function AccountLink() {
  return (
    <p className="event-card-links">
      <a className="btn-link" href={ACCOUNT_HREF} target="_blank" rel="noopener noreferrer" data-testid="link-account">your account</a>
    </p>
  );
}

/**
 * A snapshot as headings and paragraphs of plain React text (spec §5.3 step
 * 4): no HTML, no links, no images. With a watermark, it goes on every block.
 */
export function SnapshotView({ snapshot, watermark }: { snapshot: ShareSnapshot; watermark?: string }) {
  const blocks = snapshotBlocks(snapshot);
  if (blocks.length === 0) return <p className="dim">{CARRIES_NOTHING}</p>;
  return (
    <div className="share-snapshot">
      {blocks.map((b, i) => {
        const body = b.kind === "h1" ? <h2>{b.text}</h2> : b.kind === "h2" ? <h3>{b.text}</h3> : b.kind === "h3" ? <h4>{b.text}</h4> : <p>{b.text}</p>;
        return watermark ? (
          <div key={i} className="share-block">
            {body}
            <p className="share-watermark" aria-label="watermark">{watermark}</p>
          </div>
        ) : (
          <div key={i} className="share-block">{body}</div>
        );
      })}
    </div>
  );
}

type Answer = "yes" | "no" | "later";

interface Props {
  host: string;
  view: ShareView | null;
  preview: { snapshot: ShareSnapshot | null } | null;
  error: string | null;
  onDecide: (answer: Answer | "status" | "preview") => void;
}

export function ShareStep({ host, view, preview, error, onDecide }: Props) {
  const [showPreview, setShowPreview] = useState(false);
  const [sent, setSent] = useState(false);

  // Where this seat stands (a reload of the end screen).
  useEffect(() => onDecide("status"), [onDecide]);
  // Any answer back from the server gives the buttons back.
  useEffect(() => setSent(false), [view, error]);

  if (showPreview) {
    return (
      <div className="lobby stranger-mode event-card share-step" data-testid="share-preview">
        <p><strong>{previewTitle(host)}</strong> nothing else.</p>
        {!preview ? (
          error ? <p className="error">{error}</p> : <p className="dim" role="status">one moment…</p>
        ) : preview.snapshot ? (
          <>
            <SnapshotView snapshot={preview.snapshot} />
            {preview.snapshot.reportCardOmitted && <p className="dim">{REPORT_CARD_OMITTED}</p>}
          </>
        ) : (
          <p className="dim">{CARRIES_NOTHING}</p>
        )}
        <button className="btn btn-secondary" onClick={() => setShowPreview(false)}>back</button>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="lobby stranger-mode event-card share-step" role="status">
        {error ? <p className="error">{error}</p> : <p className="dim">one moment…</p>}
      </div>
    );
  }

  const line = shareViewLine(view);
  if (line) {
    return (
      <div className="lobby stranger-mode event-card share-step" role="status" data-testid="share-answered">
        <p>{line}</p>
      </div>
    );
  }

  const answer = (a: Answer) => { setSent(true); onDecide(a); };
  // H20: three equal buttons, none pre-selected, focused or styled as the default.
  return (
    <div className="lobby stranger-mode event-card share-step" data-testid="share-step">
      <h2><strong>{shareQuestion(host)}</strong></h2>
      <p>{shareExplains(host)}</p>
      <button
        className="btn-link"
        onClick={() => { setShowPreview(true); onDecide("preview"); }}
        data-testid="btn-share-preview"
      >
        {previewButton(host)}
      </button>
      <p>{SHARE_SILENCE}</p>
      <div className="event-card-actions share-answers">
        <button className="btn btn-secondary" onClick={() => answer("yes")} disabled={sent} data-testid="btn-share-yes">yes</button>
        <button className="btn btn-secondary" onClick={() => answer("no")} disabled={sent} data-testid="btn-share-no">no</button>
        <button className="btn btn-secondary" onClick={() => answer("later")} disabled={sent} data-testid="btn-share-later">decide later, on my own</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
