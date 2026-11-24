import { probeHostTools } from "./Deck";
import { useCallback, useEffect, useState } from "react";
import { formatDate } from "../hostPortal";
import {
  LEARNING_WITHDRAW,
  PANEL_NOTHING,
  REPORT_CARD_OMITTED,
  SHARE_SILENCE,
  UNLINK_REQUESTED,
  UNLINK_WARNING,
  asAccountPage,
  asShareRow,
  asSnapshot,
  codeOpeningsLine,
  forgetWarning,
  gameRowTitle,
  hostForEvent,
  learningLine,
  loadAccountPass,
  panelLine,
  previewButton,
  previewTitle,
  reportHostName,
  saveAccountPass,
  shareExplains,
  shareQuestion,
  shareRowLines,
  stopWarning,
  type AccountGame,
  type AccountPage,
  type ShareSnapshot,
} from "../shareCodes";
import { CardTerms, ReportHost } from "./EventCard";
import { SnapshotView } from "./ShareStep";

/**
 * The stranger player's account page (host tools spec §5.4, §B.5), at
 * `?stranger=account`, behind its own account pass. Share codes appear here
 * and nowhere else. Nothing on this page is tracked: no track() calls, and
 * the title screen (with its title_screen_viewed) never paints underneath.
 */

const API = import.meta.env.BASE_URL + "api";
const TRY_AGAIN = "that didn't work. try again.";
const SIGNED_OUT = "you were signed out. sign in again.";

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T; json: boolean }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => undefined)) as T | undefined;
  return { status: res.status, body: (parsed ?? {}) as T, json: parsed !== undefined };
}

/**
 * Are host tools answering the account route? A tokenless pass request is a
 * JSON 401 when they are; anything else (host tools off) and the caller shows
 * the normal title screen, as if there were no parameter.
 */
/**
 * Are host tools on? GET /host/on is the probe (a 200 saying so only when
 * they are; the deck is served in every mode now). A sign-in probe can't
 * tell: with host tools off, an unknown /api path answers a JSON 401 too.
 */
export async function probeAccount(): Promise<boolean> {
  try {
    return await probeHostTools();
  } catch {
    return false;
  }
}

/** Out of the account page: the normal app, with no ?stranger= in the address. */
function leave(): void {
  window.location.assign(import.meta.env.BASE_URL);
}

type View = "signin" | "notallowed" | "loading" | "page" | "report";
type Panel =
  | { ref: string; kind: "decide" }
  | { ref: string; kind: "preview"; snapshot: ShareSnapshot | null | undefined }
  | { ref: string; kind: "stop" }
  | { ref: string; kind: "unlink" }
  | { ref: string; kind: "learning" }
  | { ref: string; kind: "forget" };

export function Account() {
  const [pass, setPass] = useState<string | null>(() => loadAccountPass());
  const [view, setView] = useState<View>(() => (loadAccountPass() ? "loading" : "signin"));
  const [page, setPage] = useState<AccountPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingLogin, setWaitingLogin] = useState(false);
  const [openCards, setOpenCards] = useState<Set<string>>(() => new Set());
  const [panel, setPanel] = useState<Panel | null>(null);
  const [rowError, setRowError] = useState<{ ref: string; text: string } | null>(null);

  /** Any 401: the pass is gone; back to sign-in. */
  const signedOut = useCallback((note: string | null) => {
    saveAccountPass(null);
    setPass(null);
    setPage(null);
    setPanel(null);
    setRowError(null);
    setError(note);
    setView("signin");
  }, []);

  const loadPage = useCallback(async (p: string) => {
    try {
      const r = await post<unknown>("/stranger/account", { pass: p });
      if (r.status === 401) return signedOut(SIGNED_OUT);
      const parsed = r.status === 200 ? asAccountPage(r.body) : null;
      if (!parsed) {
        setError("your account didn't load. try again.");
        setView("page");
        return;
      }
      setError(null);
      setPage(parsed);
      setView("page");
    } catch {
      setError("your account didn't load. try again.");
      setView("page");
    }
  }, [signedOut]);

  // A pass from earlier in this tab: straight to the page.
  useEffect(() => {
    const p = loadAccountPass();
    if (p) void loadPage(p);
  }, [loadPage]);

  /** Matrix OpenID token → account pass → the page. */
  const exchange = useCallback(async () => {
    const ma = window.matrixAuth;
    if (!ma?.isLoggedIn()) return;
    setBusy(true);
    setError(null);
    try {
      const tok = await ma.getOpenIdToken();
      const r = await post<{ pass?: string; error?: string }>("/stranger/account/pass", { openIdToken: tok.access_token });
      // Not JSON: host tools are off. The normal app, as if there were no parameter.
      if (!r.json) return leave();
      if (r.status === 401) return setView("notallowed");
      if (r.status !== 200 || !r.body.pass) return setError(r.body.error ?? TRY_AGAIN);
      saveAccountPass(r.body.pass);
      setPass(r.body.pass);
      setView("loading");
      await loadPage(r.body.pass);
    } catch {
      setError(TRY_AGAIN);
    } finally {
      setBusy(false);
    }
  }, [loadPage]);

  // Signing in through the Matrix modal carries straight on to the exchange.
  useEffect(() => {
    if (!waitingLogin) return;
    const onLogin = () => { setWaitingLogin(false); void exchange(); };
    window.addEventListener("matrixAuthLogin", onLogin);
    return () => window.removeEventListener("matrixAuthLogin", onLogin);
  }, [waitingLogin, exchange]);

  const signIn = () => {
    setError(null);
    const ma = window.matrixAuth;
    if (!ma) return setError("sign-in isn't available right now.");
    if (!ma.isLoggedIn()) {
      setWaitingLogin(true);
      ma.showLoginModal();
      return;
    }
    void exchange();
  };

  const signOut = () => {
    signedOut(null);
    void window.matrixAuth?.logout().catch(() => {});
  };

  const replaceShare = (ref: string, share: unknown) => {
    const row = asShareRow(share);
    if (row === undefined) return false;
    setPage((pg) => (pg ? { ...pg, games: pg.games.map((g) => (g.ref === ref ? { ...g, share: row } : g)) } : pg));
    return true;
  };

  /** One row's request. A 404 means the row is gone: the page is read again. */
  const rowCall = async (ref: string, path: string, body: Record<string, unknown>, done: (b: Record<string, unknown>) => void) => {
    if (!pass) return;
    setBusy(true);
    setRowError(null);
    try {
      const r = await post<Record<string, unknown>>(path, { pass, ...body });
      if (r.status === 401) return signedOut(SIGNED_OUT);
      if (r.status === 404) { setPanel(null); await loadPage(pass); return; }
      if (r.status !== 200) {
        setRowError({ ref, text: typeof r.body.error === "string" ? r.body.error : TRY_AGAIN });
        if (r.status === 409) { setPanel(null); await loadPage(pass); }
        return;
      }
      done(r.body);
    } catch {
      setRowError({ ref, text: TRY_AGAIN });
    } finally {
      setBusy(false);
    }
  };

  const decide = (g: AccountGame, answer: "yes" | "no") =>
    rowCall(g.ref, "/stranger/account/decide", { gameRef: g.ref, answer }, (b) => {
      if (!replaceShare(g.ref, b.share)) setRowError({ ref: g.ref, text: TRY_AGAIN });
      setPanel(null);
    });

  const preview = (g: AccountGame) => {
    setPanel({ ref: g.ref, kind: "preview", snapshot: undefined });
    void rowCall(g.ref, "/stranger/share/preview", { gameRef: g.ref }, (b) => {
      const snapshot = b.preview === null ? null : asSnapshot(b.preview);
      if (b.preview !== null && !snapshot) {
        setRowError({ ref: g.ref, text: TRY_AGAIN });
        return setPanel({ ref: g.ref, kind: "decide" });
      }
      setPanel({ ref: g.ref, kind: "preview", snapshot });
    });
  };

  const stop = (g: AccountGame) =>
    rowCall(g.ref, "/stranger/account/stop", { gameRef: g.ref }, (b) => {
      if (!replaceShare(g.ref, b.share)) setRowError({ ref: g.ref, text: TRY_AGAIN });
      setPanel(null);
    });

  /** "take this game off my account" (spec §6): the code is voided now; the studio does the rest. */
  const unlink = (g: AccountGame) =>
    rowCall(g.ref, "/stranger/account/unlink", { gameRef: g.ref }, () => {
      setPanel(null);
      if (pass) void loadPage(pass);
    });

  /** Studio learning: a yes becomes no (H18). The allow-list follows at once. */
  const withdrawLearning = (g: AccountGame) =>
    rowCall(g.ref, "/stranger/account/learning", { gameRef: g.ref, answer: "no" }, () => {
      setPage((pg) => (pg ? { ...pg, games: pg.games.map((x) => (x.ref === g.ref ? { ...x, learning: "no" } : x)) } : pg));
      setPanel(null);
    });

  /** "remove from my list": deletes the attendance record (after a confirm that says so). */
  const forget = (ref: string) =>
    rowCall(ref, "/stranger/account/forget-meetup", { eventRef: ref }, () => {
      setPage((pg) => (pg ? { ...pg, meetups: pg.meetups.filter((m) => m.ref !== ref) } : pg));
      setPanel(null);
    });

  const toggleCard = (ref: string) =>
    setOpenCards((s) => {
      const next = new Set(s);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  if (view === "loading") {
    return <div className="lobby stranger-mode event-card" role="status"><p className="dim">one moment…</p></div>;
  }

  if (view === "notallowed") {
    return (
      <div className="lobby stranger-mode event-card account-page">
        <h1>your account</h1>
        <p>this account hasn't been age-checked for raising a child with someone new, so there's nothing here.</p>
        <div className="event-card-actions">
          <button className="btn btn-secondary" onClick={signOut}>sign out</button>
          <button className="btn btn-secondary" onClick={leave}>back</button>
        </div>
      </div>
    );
  }

  if (view === "signin" || !pass) {
    return (
      <div className="lobby stranger-mode event-card account-page">
        <h1>your account</h1>
        <p>sign in with your multiversegames.ai account.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn" onClick={signIn} disabled={busy} data-testid="btn-account-signin">
          {busy ? "one moment…" : "sign in"}
        </button>
        <button className="btn btn-secondary" onClick={leave}>back</button>
      </div>
    );
  }

  if (view === "report") {
    return <ReportHost host={reportHostName(page?.meetups ?? [])} onBack={() => setView("page")} />;
  }

  const meetups = page?.meetups ?? [];
  const games = page?.games ?? [];
  const hostSaw = page?.hostSaw ?? [];

  const gameRow = (g: AccountGame) => {
    const lines = g.share ? shareRowLines(g.share) : null;
    const host = g.share?.state === "code" ? g.share.host : hostForEvent(meetups, g.eventName);
    const p = panel?.ref === g.ref ? panel : null;
    const learning = learningLine(g.learning);
    return (
      <div key={g.ref} className="account-game" data-testid="account-game">
        <p><strong>{gameRowTitle(g)}</strong></p>
        {lines && (
          <p className="account-share-line">
            {lines.runs.map((r, i) => (r.bold ? <strong key={i}>{r.text}</strong> : <span key={i}>{r.text}</span>))}
          </p>
        )}
        {lines?.access && <p className="dim">{lines.access}</p>}

        {lines?.action === "decide" && !p && (
          <button className="btn btn-secondary" onClick={() => { setRowError(null); setPanel({ ref: g.ref, kind: "decide" }); }} disabled={busy}>
            decide now
          </button>
        )}
        {p?.kind === "decide" && (
          <div className="account-panel">
            <p><strong>{shareQuestion(host)}</strong></p>
            <p>{shareExplains(host)}</p>
            <button className="btn-link" onClick={() => preview(g)} disabled={busy}>{previewButton(host)}</button>
            <p>{SHARE_SILENCE}</p>
            {/* H20: two equal buttons, neither pre-selected, focused or styled as the default. */}
            <div className="event-card-actions">
              <button className="btn btn-secondary" onClick={() => void decide(g, "yes")} disabled={busy}>yes</button>
              <button className="btn btn-secondary" onClick={() => void decide(g, "no")} disabled={busy}>no</button>
            </div>
            <button className="btn-link" onClick={() => setPanel(null)}>back</button>
          </div>
        )}
        {p?.kind === "preview" && (
          <div className="account-panel">
            <p><strong>{previewTitle(host)}</strong> nothing else.</p>
            {p.snapshot === undefined ? (
              <p className="dim" role="status">one moment…</p>
            ) : (
              <>
                <SnapshotView snapshot={p.snapshot ?? { reportCard: null, epilogue: null, reportCardOmitted: false }} />
                {p.snapshot?.reportCardOmitted && <p className="dim">{REPORT_CARD_OMITTED}</p>}
              </>
            )}
            <button className="btn btn-secondary" onClick={() => setPanel({ ref: g.ref, kind: "decide" })}>back</button>
          </div>
        )}

        {lines?.action === "stop" && !p && (
          <button className="btn btn-secondary" onClick={() => { setRowError(null); setPanel({ ref: g.ref, kind: "stop" }); }} disabled={busy}>
            stop this code
          </button>
        )}
        {p?.kind === "stop" && (
          <div className="account-panel">
            <p>{stopWarning(host)}</p>
            <div className="event-card-actions">
              <button className="btn btn-secondary" onClick={() => void stop(g)} disabled={busy}>stop this code</button>
              <button className="btn btn-secondary" onClick={() => setPanel(null)} disabled={busy}>back</button>
            </div>
          </div>
        )}
        {learning && <p className="dim">{learning}</p>}
        {g.learning === "yes" && !p && (
          <button className="btn-link" onClick={() => { setRowError(null); setPanel({ ref: g.ref, kind: "learning" }); }} disabled={busy}>
            change it to no
          </button>
        )}
        {p?.kind === "learning" && (
          <div className="account-panel">
            <p>{LEARNING_WITHDRAW}</p>
            <div className="event-card-actions">
              <button className="btn btn-secondary" onClick={() => void withdrawLearning(g)} disabled={busy}>change it to no</button>
              <button className="btn btn-secondary" onClick={() => setPanel(null)} disabled={busy}>back</button>
            </div>
          </div>
        )}

        {g.unlink === "requested" ? (
          <p className="dim" data-testid="account-unlink-requested">{UNLINK_REQUESTED}</p>
        ) : p?.kind === "unlink" ? (
          <div className="account-panel">
            <p>{UNLINK_WARNING}</p>
            <div className="event-card-actions">
              <button className="btn btn-secondary" onClick={() => void unlink(g)} disabled={busy}>take it off my account</button>
              <button className="btn btn-secondary" onClick={() => setPanel(null)} disabled={busy}>cancel</button>
            </div>
          </div>
        ) : !p && (
          <button className="btn-link" onClick={() => { setRowError(null); setPanel({ ref: g.ref, kind: "unlink" }); }} disabled={busy}>
            take this game off my account
          </button>
        )}
        {rowError?.ref === g.ref && <p className="error">{rowError.text}</p>}
      </div>
    );
  };

  return (
    <div className="lobby stranger-mode event-card account-page" data-testid="account-page">
      <h1>your account</h1>
      <p className="event-card-links">
        <button className="btn-link" onClick={signOut}>sign out</button>
        {" · "}
        <button className="btn-link" onClick={leave}>back</button>
      </p>
      {error && <p className="error">{error}</p>}
      {error && !page && <button className="btn" onClick={() => void loadPage(pass)}>try again</button>}

      {page && (
        <>
          <section className="event-card-section">
            <h2><strong>meetups you joined</strong></h2>
            {meetups.length === 0 && <p className="dim">nothing here yet.</p>}
            {meetups.map((m) => (
              <div key={m.ref} className="account-meetup" data-testid="account-meetup">
                <p>
                  <strong>{m.name}</strong> · {formatDate(m.at)} ·{" "}
                  <button className="btn-link" onClick={() => toggleCard(m.ref)} aria-expanded={openCards.has(m.ref)}>the card you agreed to</button>
                  {" · "}
                  <button className="btn-link" onClick={() => { setRowError(null); setPanel({ ref: m.ref, kind: "forget" }); }} disabled={busy}>remove from my list</button>
                </p>
                {panel?.ref === m.ref && panel.kind === "forget" && (
                  <div className="account-panel">
                    <p>{forgetWarning(m.name)}</p>
                    <div className="event-card-actions">
                      <button className="btn btn-secondary" onClick={() => void forget(m.ref)} disabled={busy}>delete it</button>
                      <button className="btn btn-secondary" onClick={() => setPanel(null)} disabled={busy}>cancel</button>
                    </div>
                  </div>
                )}
                {openCards.has(m.ref) && (
                  <div className="account-card">
                    {m.card ? <CardTerms card={m.card} headingLevel={2} /> : <p className="dim">that card isn't available.</p>}
                  </div>
                )}
                {rowError?.ref === m.ref && <p className="error">{rowError.text}</p>}
              </div>
            ))}
          </section>

          <section className="event-card-section">
            <h2><strong>your games</strong></h2>
            {games.length === 0 && <p className="dim">nothing here yet.</p>}
            {games.map(gameRow)}
          </section>

          <section className="event-card-section">
            <h2><strong>what the host or guest saw</strong></h2>
            {hostSaw.length === 0 && <p>{PANEL_NOTHING}</p>}
            {hostSaw.map((h, i) => (
              <p key={i}><strong>{h.name}</strong>: {panelLine(h.panel)}</p>
            ))}
            {codeOpeningsLine(games.some((g) => g.share !== null)) && (
              <p className="dim">{codeOpeningsLine(games.some((g) => g.share !== null))}</p>
            )}
          </section>
        </>
      )}

      <p className="event-card-links">
        <button className="btn-link" onClick={() => setView("report")} data-testid="btn-account-report">report this host</button>
      </p>
    </div>
  );
}
