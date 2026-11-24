import { useCallback, useEffect, useState } from "react";
import {
  numbersNote,
  asPortalEvents,
  dateRange,
  funnelLine,
  hostActions,
  loadHostPass,
  saveHostPass,
  showShareCodes,
  statusLabel,
  type Deck as DeckData,
  type GuestEv,
  type HostEv,
  type PortalEvents,
} from "../hostPortal";
import { Deck } from "./Deck";
import { HostCodes } from "./HostCodes";
import { HostEventLink } from "./HostEventLink";
import { HostTermsView } from "./HostTermsView";
import { asTerms } from "../hostInvite";

/**
 * The meetup host portal (host tools spec §4, B.4, B.5), at `?host=1`. Hosts
 * see each event's status and, a day after it closes, the published bands.
 * Guest readers see only the event's name and dates. Nothing on these screens
 * is tracked: no track() calls, and the title screen (with its
 * title_screen_viewed) never paints underneath.
 */

const API = import.meta.env.BASE_URL + "api";

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

type View = "signin" | "nothost" | "loading" | "events" | "deck";
type Action = "pause" | "resume" | "close" | "lower";

const TRY_AGAIN = "that didn't work. try again.";

/** Out of the portal: the normal app, with no ?host= in the address. */
function leave(): void {
  window.location.assign(import.meta.env.BASE_URL);
}

export function HostPortal({ deck }: { deck: DeckData }) {
  const [pass, setPass] = useState<string | null>(() => loadHostPass());
  const [view, setView] = useState<View>(() => (loadHostPass() ? "loading" : "signin"));
  const [data, setData] = useState<PortalEvents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingLogin, setWaitingLogin] = useState(false);
  const [actionError, setActionError] = useState<{ ref: string; text: string } | null>(null);
  const [backFromDeck, setBackFromDeck] = useState<View>("signin");

  /** Any 401: the pass is gone; back to sign-in. */
  const signedOut = useCallback((note: string | null) => {
    saveHostPass(null);
    setPass(null);
    setData(null);
    setActionError(null);
    setError(note);
    setView("signin");
  }, []);

  const loadEvents = useCallback(async (p: string) => {
    try {
      const r = await post<unknown>("/host/events", { pass: p });
      if (r.status === 401) return signedOut("you were signed out. sign in again.");
      const parsed = r.status === 200 ? asPortalEvents(r.body) : null;
      if (!parsed) {
        setError((r.body as { error?: string }).error ?? "your meetups didn't load. try again.");
        setView("events");
        return;
      }
      setError(null);
      setData(parsed);
      setView("events");
    } catch {
      setError("your meetups didn't load. try again.");
      setView("events");
    }
  }, [signedOut]);

  // A pass from earlier in this tab: straight to the list.
  useEffect(() => {
    const p = loadHostPass();
    if (p) void loadEvents(p);
  }, [loadEvents]);

  /** Matrix OpenID token → host pass → the list. */
  const exchange = useCallback(async () => {
    const ma = window.matrixAuth;
    if (!ma?.isLoggedIn()) return;
    setBusy(true);
    setError(null);
    try {
      const tok = await ma.getOpenIdToken();
      const r = await post<{ pass?: string; error?: string }>("/host/pass", { openIdToken: tok.access_token });
      if (r.status === 401) return setView("nothost");
      if (r.status !== 200 || !r.body.pass) return setError(r.body.error ?? TRY_AGAIN);
      saveHostPass(r.body.pass);
      setPass(r.body.pass);
      setView("loading");
      await loadEvents(r.body.pass);
    } catch {
      setError(TRY_AGAIN);
    } finally {
      setBusy(false);
    }
  }, [loadEvents]);

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

  const act = async (e: HostEv, action: Action) => {
    if (!pass) return;
    if (action === "close" && !window.confirm(`close ${e.name}? nobody new can join once it's closed.`)) return;
    if (
      action === "lower" &&
      !window.confirm(
        `lower the level of ${e.name}? players will see a new card, and anyone who already agreed to the old one will be asked to read the new one before they go on. you can't raise it again from here.`,
      )
    ) return;
    setBusy(true);
    setActionError(null);
    try {
      const r = await post<{ ok?: boolean; error?: string }>(`/host/events/${encodeURIComponent(e.ref)}/${action}`, { pass });
      if (r.status === 401) return signedOut("you were signed out. sign in again.");
      if (r.status !== 200 || !r.body.ok) return setActionError({ ref: e.ref, text: r.body.error ?? TRY_AGAIN });
      await loadEvents(pass);
    } catch {
      setActionError({ ref: e.ref, text: TRY_AGAIN });
    } finally {
      setBusy(false);
    }
  };

  const openDeck = () => { setBackFromDeck(view); setView("deck"); };
  const deckLink = (
    <button className="btn-link" onClick={openDeck} data-testid="btn-host-deck">discussion deck</button>
  );

  if (view === "deck") return <Deck deck={deck} onBack={() => setView(backFromDeck)} />;

  if (view === "loading") {
    return <div className="lobby stranger-mode event-card" role="status"><p className="dim">one moment…</p></div>;
  }

  if (view === "nothost") {
    return (
      <div className="lobby stranger-mode event-card host-portal">
        <h1>host tools · prototype</h1>
        <p>this account isn't a host or guest reader here.</p>
        <div className="event-card-actions">
          <button className="btn btn-secondary" onClick={signOut}>sign out</button>
          <button className="btn btn-secondary" onClick={leave}>back</button>
        </div>
      </div>
    );
  }

  if (view === "signin" || !pass) {
    return (
      <div className="lobby stranger-mode event-card host-portal">
        <h1>host tools · prototype</h1>
        <p>sign in with your multiversegames.ai account.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn" onClick={signIn} disabled={busy} data-testid="btn-host-signin">
          {busy ? "one moment…" : "sign in"}
        </button>
        <p className="event-card-links">{deckLink}</p>
        <button className="btn btn-secondary" onClick={leave}>back</button>
      </div>
    );
  }

  // Added by the studio without a signed agreement: the terms first (persona tests, S2-5).
  if (data?.needsAgreement) {
    const terms = data.needsAgreement;
    const agree = async () => {
      setBusy(true);
      setError(null);
      try {
        const r = await post<{ ok?: boolean; error?: string; terms?: unknown }>("/host/agree", { pass, version: terms.version });
        if (r.status === 401) return signedOut("you were signed out. sign in again.");
        if (r.status === 409) {
          const t = asTerms(r.body.terms);
          if (t) { setData({ ...data, needsAgreement: t }); return setError("the terms changed while you were reading. here are the current ones."); }
        }
        if (r.status !== 200) return setError(r.body.error ?? TRY_AGAIN);
        await loadEvents(pass);
      } catch {
        setError(TRY_AGAIN);
      } finally {
        setBusy(false);
      }
    };
    return (
      <HostTermsView terms={terms} busy={busy} error={error} onAgree={() => void agree()}>
        <p className="event-card-links">
          {data.displayName && <>signed in as {data.displayName} · </>}
          <button className="btn-link" onClick={signOut}>sign out</button>
        </p>
      </HostTermsView>
    );
  }

  const events = data?.events ?? [];
  const hostEvent = (e: HostEv) => {
    const a = hostActions(e);
    const line = funnelLine(e.funnel);
    return (
      <section key={e.ref} className="event-card-section host-event" data-testid="host-event">
        <h2><strong>{e.name}</strong> · {statusLabel(e.status)}</h2>
        <p className="dim">{dateRange(e.opensAt, e.closesAt)}</p>
        {numbersNote(e.status, !!line) && <p className="dim">{numbersNote(e.status, !!line)}</p>}
        {line && <p>{line}</p>}
        <HostEventLink pass={pass} eventRef={e.ref} closed={e.status === "closed"} onSignedOut={() => signedOut("you were signed out. sign in again.")} />
        {(a.toggle || a.close || a.lower) && (
          <div className="event-card-actions host-event-actions">
            {a.toggle && (
              <button className="btn btn-secondary" onClick={() => void act(e, a.toggle!)} disabled={busy}>{a.toggle}</button>
            )}
            {a.close && <button className="btn btn-secondary" onClick={() => void act(e, "close")} disabled={busy}>close</button>}
            {a.lower && <button className="btn btn-secondary" onClick={() => void act(e, "lower")} disabled={busy}>lower the level</button>}
          </div>
        )}
        {actionError?.ref === e.ref && <p className="error">{actionError.text}</p>}
      </section>
    );
  };
  const guestEvent = (e: GuestEv) => (
    <section key={e.ref} className="event-card-section host-event" data-testid="guest-event">
      <p>you're a guest at <strong>{e.name}</strong>. you only see what a pair gives you.</p>
      <p className="dim">{dateRange(e.opensAt, e.closesAt)}</p>
    </section>
  );

  return (
    <div className="lobby stranger-mode event-card host-portal" data-testid="host-portal">
      <h1>host tools · prototype</h1>
      <p className="event-card-links">
        {data?.displayName && <>signed in as {data.displayName} · </>}
        <button className="btn-link" onClick={signOut}>sign out</button>
        {" · "}
        {deckLink}
      </p>
      {error && <p className="error">{error}</p>}
      {error && !data && <button className="btn" onClick={() => void loadEvents(pass)}>try again</button>}
      {data && events.length === 0 && <p className="dim">you don't host or read for any meetups right now.</p>}
      {events.map((e) => (e.role === "host" ? hostEvent(e) : guestEvent(e)))}
      {data && showShareCodes(events) && <HostCodes pass={pass} onSignedOut={() => signedOut(null)} />}
    </div>
  );
}
