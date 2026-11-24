import { useState } from "react";
import { CODE_NOT_AVAILABLE, asCodeView, openUntil, watermarkLine, type CodeView } from "../shareCodes";
import { SnapshotView } from "./ShareStep";

/**
 * The host portal's share codes section (spec §5.2, §B.5): enter the four
 * words a pair gave you, then read what they carry. Every failure reads
 * "this code isn't available." The code's ref lives only in this component's
 * state (never storage, never the URL), and every block of the code view
 * carries the reader's watermark. Nothing here is tracked.
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

export function HostCodes({ pass, onSignedOut }: { pass: string; onSignedOut: () => void }) {
  const [entering, setEntering] = useState(false);
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ codeRef: string; view: CodeView } | null>(null);

  const open = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!words.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ codeRef?: string }>("/host/codes/redeem", { pass, words });
      if (r.status === 401) return onSignedOut();
      // Every failure is the same line: wrong, expired, stopped, someone else's, rate-limited.
      if (r.status !== 200 || typeof r.body.codeRef !== "string" || !r.body.codeRef) return setError(CODE_NOT_AVAILABLE);
      const codeRef = r.body.codeRef;
      const v = await post<unknown>("/host/codes/view", { pass, codeRef });
      if (v.status === 401) return onSignedOut();
      const view = v.status === 200 ? asCodeView(v.body) : null;
      if (!view) return setError(v.status === 404 || v.status === 200 ? CODE_NOT_AVAILABLE : TRY_AGAIN);
      setWords("");
      setCode({ codeRef, view });
    } catch {
      setError(TRY_AGAIN);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setCode(null);
    setEntering(false);
    setError(null);
  };

  if (code) {
    const mark = watermarkLine(code.view.watermark);
    return (
      <section className="event-card-section host-codes code-view" data-testid="code-view">
        <h2>share codes</h2>
        <p className="share-watermark">{mark}</p>
        <p>{openUntil(code.view.until)}</p>
        <SnapshotView snapshot={code.view.snapshot} watermark={mark} />
        <button className="btn btn-secondary" onClick={close}>back</button>
      </section>
    );
  }

  return (
    <section className="event-card-section host-codes" data-testid="host-codes">
      <h2>share codes</h2>
      <p>RI never shows you who played or who made a code. please don't ask anyone whether they made one.</p>
      {!entering ? (
        <button className="btn btn-secondary" onClick={() => setEntering(true)} data-testid="btn-enter-code">
          enter a code a pair gave you
        </button>
      ) : (
        <form onSubmit={open} className="event-card-report">
          <input
            className="name-input"
            aria-label="the four words"
            placeholder="four words"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={80}
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          {error && <p className="error" role="status">{error}</p>}
          <div className="event-card-actions">
            <button className="btn" type="submit" disabled={busy || !words.trim()} data-testid="btn-open-code">
              {busy ? "one moment…" : "open"}
            </button>
            <button className="btn btn-secondary" type="button" onClick={close} disabled={busy}>back</button>
          </div>
        </form>
      )}
    </section>
  );
}
