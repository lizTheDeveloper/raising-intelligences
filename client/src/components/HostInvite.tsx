import { useCallback, useEffect, useState } from "react";
import { asInvitePeek, asTerms, loadInvite, saveInvite, type InvitePeek, type StoredInvite } from "../hostInvite";
import { saveHostPass } from "../hostPortal";
import { HostTermsView } from "./HostTermsView";

/**
 * Host onboarding by invite (persona tests, S2-5), at `?hostinvite=<token>`.
 * The studio sends a host or guest reader this link. They sign in, take the
 * same 18+ check as players (with copy written for them), read and agree to
 * the host terms, and land on their portal. No meetup, no player card, no
 * queue. Nothing here is tracked.
 *
 * The token leaves the address bar at once and lives only in this tab's
 * storage, so the Stripe return (`?hostinvite=back`) never carries it.
 */

const API = import.meta.env.BASE_URL + "api";
const TRY_AGAIN = "that didn't work. try again.";
const GONE = "this invite isn't available.";

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

type Step = "loading" | "gone" | "welcome" | "consent" | "idcheck" | "checking" | "minor" | "already" | "terms";

interface Status { adult?: boolean; consented?: boolean; minor?: boolean; error?: string }

function leave(): void {
  window.location.assign(import.meta.env.BASE_URL);
}

export function HostInvite({ route }: { route: { token: string } | { back: true } }) {
  const [invite, setInvite] = useState<StoredInvite | null>(null);
  const [peek, setPeek] = useState<InvitePeek | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [waitingLogin, setWaitingLogin] = useState(false);

  const keep = useCallback((v: StoredInvite | null) => { saveInvite(v); setInvite(v); }, []);

  /** Where the person is, from the server's answer. */
  const go = useCallback((s: Status) => {
    if (s.minor) return setStep("minor");
    if (s.adult) return setStep("terms");
    if (s.consented) return setStep("idcheck");
    setStep("consent");
  }, []);

  /** A pass that's gone (expired, or the invite was used or revoked): ask again from the start. */
  const lost = useCallback(async (token: string) => {
    const r = await post<unknown>("/host/invite/peek", { invite: token }).catch(() => null);
    const p = r?.status === 200 ? asInvitePeek(r.body) : null;
    if (!p) { keep(null); return setStep("gone"); }
    keep({ token, invitePass: null });
    setPeek(p);
    setNote("please sign in again.");
    setStep("welcome");
  }, [keep]);

  const check = useCallback(async (stored: StoredInvite) => {
    if (!stored.invitePass) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<Status>("/host/invite/identity/check", { invitePass: stored.invitePass });
      if (r.status === 404) return void (await lost(stored.token));
      if (r.status !== 200) return setError(r.body.error ?? TRY_AGAIN);
      if (!r.body.adult && !r.body.minor) return setStep("checking");
      go(r.body);
    } catch {
      setError(TRY_AGAIN);
    } finally {
      setBusy(false);
    }
  }, [go, lost]);

  // On arrival: take the token out of the address bar, keep it for this tab, read the invite.
  useEffect(() => {
    const stored = "token" in route ? { token: route.token, invitePass: null } : loadInvite();
    window.history.replaceState(null, "", import.meta.env.BASE_URL);
    if (!stored) return setStep("gone");
    keep(stored);
    let live = true;
    void post<unknown>("/host/invite/peek", { invite: stored.token })
      .then((r) => {
        if (!live) return;
        const p = r.status === 200 ? asInvitePeek(r.body) : null;
        if (!p) { keep(null); return setStep("gone"); }
        setPeek(p);
        if ("back" in route && stored.invitePass) { setStep("checking"); void check(stored); }
        else setStep("welcome");
      })
      .catch(() => { if (live) { setError(TRY_AGAIN); setStep("welcome"); } });
    return () => { live = false; };
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Matrix OpenID token → invite pass → the next step. */
  const exchange = useCallback(async () => {
    const ma = window.matrixAuth;
    if (!ma?.isLoggedIn() || !invite) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const tok = await ma.getOpenIdToken();
      const r = await post<Status & { invitePass?: string }>("/host/invite/pass", { invite: invite.token, openIdToken: tok.access_token });
      if (r.status === 404) { keep(null); return setStep("gone"); }
      if (r.status === 403) return r.body.minor ? setStep("minor") : setError(r.body.error ?? TRY_AGAIN);
      if (r.status === 409) return setStep("already");
      if (r.status !== 200 || !r.body.invitePass) return setError(r.body.error ?? TRY_AGAIN);
      keep({ token: invite.token, invitePass: r.body.invitePass });
      go(r.body);
    } catch {
      setError(TRY_AGAIN);
    } finally {
      setBusy(false);
    }
  }, [invite, keep, go]);

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
    if (!ma.isLoggedIn()) { setWaitingLogin(true); ma.showLoginModal(); return; }
    void exchange();
  };

  const run = async (fn: (ip: string) => Promise<void>) => {
    if (!invite?.invitePass) return void (invite ? lost(invite.token) : setStep("gone"));
    setBusy(true);
    setError(null);
    try { await fn(invite.invitePass); } catch { setError(TRY_AGAIN); } finally { setBusy(false); }
  };

  const consent = () => run(async (ip) => {
    const r = await post<Status>("/host/invite/consent", { invitePass: ip, version: peek?.consentVersion });
    if (r.status === 404) return void (await lost(invite!.token));
    if (r.status !== 200) return setError(r.body.error ?? TRY_AGAIN);
    go(r.body);
  });

  const startCheck = () => run(async (ip) => {
    const r = await post<{ url?: string; error?: string }>("/host/invite/identity/start", { invitePass: ip });
    if (r.status === 404) return void (await lost(invite!.token));
    if (r.status === 403) return setStep("minor");
    if (r.status === 200 && r.body.url) return window.location.assign(r.body.url);
    setError(r.body.error ?? "the ID check didn't open. try again.");
  });

  const agree = () => run(async (ip) => {
    if (!peek) return;
    const r = await post<{ ok?: boolean; error?: string; terms?: unknown }>("/host/invite/accept", { invitePass: ip, termsVersion: peek.terms.version });
    if (r.status === 404) return void (await lost(invite!.token));
    if (r.status === 403) return setStep("idcheck");
    if (r.status === 409) {
      const t = asTerms(r.body.terms);
      if (t) { setPeek({ ...peek, terms: t }); return setError("the terms changed while you were reading. here are the current ones."); }
      return setError(r.body.error ?? TRY_AGAIN);
    }
    if (r.status !== 200) return setError(r.body.error ?? TRY_AGAIN);
    keep(null);
    // Straight into the portal, already signed in.
    try {
      const tok = await window.matrixAuth?.getOpenIdToken();
      const hp = tok ? await post<{ pass?: string }>("/host/pass", { openIdToken: tok.access_token }) : null;
      if (hp?.status === 200 && hp.body.pass) saveHostPass(hp.body.pass);
    } catch { /* the portal asks them to sign in */ }
    window.location.assign(`${import.meta.env.BASE_URL}?host=1`);
  });

  const back = <button className="btn btn-secondary" onClick={leave}>back to the game</button>;
  const shell = (children: React.ReactNode, extra = "") => (
    <div className={`lobby stranger-mode event-card host-portal host-invite ${extra}`} data-testid="host-invite">{children}</div>
  );

  if (step === "loading") return <div className="lobby stranger-mode event-card" role="status"><p className="dim">one moment…</p></div>;

  if (step === "gone") return shell(<><h1>host tools · prototype</h1><p>{GONE}</p><p className="dim">if you were expecting one, ask the studio for a new link.</p>{back}</>);

  if (step === "minor") {
    return shell(<>
      <h1>this one is for adults</h1>
      <p className="dim">hosting and reading at RI meetups is only for people 18 and over. solo play and invite play stay open to you.</p>
      {back}
    </>);
  }

  if (step === "already") {
    return shell(<>
      <h1>you're already set up</h1>
      <p>this account is already a host or guest reader here.</p>
      <button className="btn" onClick={() => { keep(null); window.location.assign(`${import.meta.env.BASE_URL}?host=1`); }}>go to your page</button>
    </>);
  }

  if (step === "terms" && peek) return <HostTermsView terms={peek.terms} busy={busy} error={error} onAgree={() => void agree()} />;

  if (step === "checking") {
    return shell(<>
      <h1>checking…</h1>
      <p className="dim">reading the result of your ID check.</p>
      {error && <p className="error">{error}</p>}
      {invite?.invitePass && <button className="btn" onClick={() => void check(invite)} disabled={busy}>check again</button>}
    </>);
  }

  if (step === "consent") {
    return shell(<>
      <h1>the 18+ check</h1>
      <p>RI meetups are only for adults, so every host and guest reader shows an ID and takes a live selfie: the same check every player takes. no exceptions.</p>
      <section className="event-card-section">
      <ul className="dim">
        <li>the check is run by Stripe Identity, our ID-check provider. it compares your face in the selfie with the photo on your ID. that comparison uses biometric data (a face geometry template).</li>
        <li>we ask Stripe one thing: is this person 18 or over? we never store your ID, your selfie, your name or your date of birth.</li>
        <li>once we have the answer we ask Stripe to delete (redact) the check. Stripe may keep some records for a time where the law requires it.</li>
        <li>we keep three things against your account: the answer (18+ or not), so you don't have to show your ID again; the id of Stripe's check, to match Stripe's reply to you and limit how often checks are started; and a coded fingerprint of your ID's number and issuing country, made with a secret key, so one ID can't open two accounts. none of these is biometric data. there's no end date on them yet, and no way yet to ask for them to be deleted.</li>
        <li>if the check says you are under 18, this account can't host or read at RI meetups. solo play and invite play stay open to you.</li>
        <li>players at your meetups never see any of this.</li>
      </ul>
      </section>
      <p className="dim">by agreeing you give written consent to the collection and use of your biometric data, as described above, for age verification only.</p>
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={() => void consent()} disabled={busy} data-testid="btn-host-invite-consent">{busy ? "saving…" : "I agree"}</button>
      {back}
    </>);
  }

  if (step === "idcheck") {
    return shell(<>
      <h1>show your ID</h1>
      <p className="dim">you'll go to Stripe, take a photo of your ID and a short selfie, and come back here to read the host terms.</p>
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={() => void startCheck()} disabled={busy} data-testid="btn-host-invite-idcheck">{busy ? "opening…" : "start the ID check"}</button>
      {back}
    </>);
  }

  return shell(<>
    <h1>host tools · prototype</h1>
    <p>{peek ? <>hi {peek.displayName}. </> : null}the studio has invited you to host or read at Raising Intelligences meetups.</p>
    <p className="dim">it takes three steps: sign in with your multiversegames.ai account, pass the 18+ check every player takes, and read and agree to the host terms. then your page opens.</p>
    <p className="dim">you won't see a meetup card or join a queue: this is only for setting up your page.</p>
    {note && <p>{note}</p>}
    {error && <p className="error">{error}</p>}
    <button className="btn" onClick={signIn} disabled={busy} data-testid="btn-host-invite-signin">{busy ? "one moment…" : "sign in"}</button>
    {back}
  </>);
}
