import { useCallback, useEffect, useState } from "react";
import {
  CODE_NOT_AVAILABLE,
  CODES_PAUSED,
  asCodeView,
  asOpenedCodes,
  openUntil,
  openedCodeLine,
  watermarkLine,
  type CodeView,
  type OpenedCode,
} from "../shareCodes";
import { SnapshotView } from "./ShareStep";

/**
 * The host portal's share codes section (spec §5.2, §B.5): enter the four
 * words a pair gave you, then read what they carry. Every failure reads
 * "this code isn't available." Codes the reader has already opened are
 * listed while she can still read them, so she re-opens them without the
 * words and without counting against the limit (persona tests, S2-1). Code
 * refs live only in this component's state (never storage, never the URL).
 * The code view carries one sticky watermark and a faint mark behind the
 * text (S3-3). Nothing here is tracked.
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

/** The watermark, tiled faintly behind the text: a screenshot of any part still carries it. */
function markTile(text: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="160"><text x="0" y="90" transform="rotate(-18 210 80)" font-family="monospace" font-size="12" fill="#888888" fill-opacity="0.14">${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</text></svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

export function HostCodes({ pass, onSignedOut }: { pass: string; onSignedOut: () => void }) {
  const [entering, setEntering] = useState(false);
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ codeRef: string; view: CodeView; label: string | null } | null>(null);
  const [opened, setOpened] = useState<OpenedCode[]>([]);

  const refresh = useCallback(async (): Promise<OpenedCode[]> => {
    try {
      const r = await post<unknown>("/host/codes/list", { pass });
      if (r.status === 401) { onSignedOut(); return []; }
      const list = r.status === 200 ? asOpenedCodes(r.body) : [];
      setOpened(list);
      return list;
    } catch {
      return [];
    }
  }, [pass, onSignedOut]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Reads a code she holds: no redemption, nothing counted. */
  const view = async (codeRef: string, known?: OpenedCode) => {
    const v = await post<unknown>("/host/codes/view", { pass, codeRef });
    if (v.status === 401) { onSignedOut(); return false; }
    const cv = v.status === 200 ? asCodeView(v.body) : null;
    if (!cv) { setError(v.status === 404 || v.status === 200 ? CODE_NOT_AVAILABLE : TRY_AGAIN); return false; }
    const entry = known ?? (await refresh()).find((c) => c.codeRef === codeRef);
    setCode({ codeRef, view: cv, label: entry ? openedCodeLine(entry) : null });
    return true;
  };

  const open = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!words.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ codeRef?: string }>("/host/codes/redeem", { pass, words });
      if (r.status === 401) return onSignedOut();
      // Too many failures lately: the same answer for every new code, right or wrong.
      if (r.status === 429) return setError(CODES_PAUSED);
      // Every other failure is the same line: wrong, expired, stopped, someone else's.
      if (r.status !== 200 || typeof r.body.codeRef !== "string" || !r.body.codeRef) return setError(CODE_NOT_AVAILABLE);
      if (await view(r.body.codeRef)) setWords("");
    } catch {
      setError(TRY_AGAIN);
    } finally {
      setBusy(false);
    }
  };

  const reopen = async (c: OpenedCode) => {
    setBusy(true);
    setError(null);
    try {
      await view(c.codeRef, c);
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
    void refresh();
  };

  if (code) {
    const mark = watermarkLine(code.view.watermark);
    return (
      <section
        className="event-card-section host-codes code-view"
        data-testid="code-view"
        style={{ backgroundImage: markTile(mark) }}
      >
        <p className="share-watermark code-watermark-bar" role="note" aria-label="watermark" data-testid="code-watermark">{mark}</p>
        <h2>share codes</h2>
        {code.label && <p className="dim" data-testid="code-label">{code.label}</p>}
        <p>{openUntil(code.view.until)}</p>
        <SnapshotView snapshot={code.view.snapshot} />
        <button className="btn btn-secondary" onClick={close}>back</button>
      </section>
    );
  }

  return (
    <section className="event-card-section host-codes" data-testid="host-codes">
      <h2>share codes</h2>
      <p>RI never shows you who played or who made a code. please don't ask anyone whether they made one.</p>
      {opened.length > 0 && (
        <div className="opened-codes" data-testid="opened-codes">
          <h3>codes you've opened</h3>
          <p className="dim">open them again here, as often as you need, while you can still read them. no need to type the words again.</p>
          <ul>
            {opened.map((c) => (
              <li key={c.codeRef}>
                <span>{openedCodeLine(c)}</span>{" "}
                <button className="btn btn-secondary" onClick={() => reopen(c)} disabled={busy} data-testid="btn-reopen-code">read</button>
              </li>
            ))}
          </ul>
          {!entering && error && <p className="error" role="status">{error}</p>}
        </div>
      )}
      {!entering ? (
        <button className="btn btn-secondary" onClick={() => { setError(null); setEntering(true); }} data-testid="btn-enter-code">
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
