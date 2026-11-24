import { useCallback, useEffect, useState } from "react";
import { track } from "../analytics";
import { asCard, loadAck, neverBuilt, type MeetupCard } from "../meetupCard";
import { MINOR_OTHER_WAYS } from "../strangerCopy";

const API = import.meta.env.BASE_URL + "api";
const PASS_KEY = "ri_stranger_pass";

/** The stranger pass survives the round trip to Stripe Identity (same tab). */
function loadPass(): string | null {
  try { return sessionStorage.getItem(PASS_KEY); } catch { return null; }
}
function savePass(p: string | null): void {
  try { if (p) sessionStorage.setItem(PASS_KEY, p); else sessionStorage.removeItem(PASS_KEY); } catch { /* private window */ }
}

async function call<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

interface Me {
  consented: boolean;
  age: "adult" | "minor" | "unverified";
  eligible: boolean;
  reason?: string;
}

type Step = "signin" | "consent" | "idcheck" | "checking" | "eligible" | "minor" | "closed";

interface Props {
  meetup: string | null;
  consentVersion: string;
  onBack: () => void;
  /** Rendered once this player is a verified adult: the queue (Phase 4). */
  renderEligible?: (pass: string) => React.ReactNode;
  /** Meetup "get ready early": stop after the age check instead of opening the queue. */
  prepareOnly?: boolean;
  /** The server wants the meetup card read again (a 409 with the current card); `retry` signs in again after. */
  onCardChanged?: (card: MeetupCard, retry: () => void) => void;
}

/**
 * Stranger mode's front door: Matrix sign-in, the ID-check consent, and the
 * Stripe Identity check. Nobody gets past it without passing as an adult.
 */
export function StrangerMode({ meetup, consentVersion, onBack, renderEligible, prepareOnly, onCardChanged }: Props) {
  const [pass, setPass] = useState<string | null>(() => loadPass());
  const [step, setStep] = useState<Step>("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((me: Me) => {
    if (me.age === "minor") return setStep("minor");
    if (me.eligible) return setStep("eligible");
    if (!me.consented) return setStep("consent");
    setStep("idcheck");
  }, []);

  const refresh = useCallback(async (p: string, checkStripe: boolean) => {
    const r = await call<Me & { error?: string }>(checkStripe ? "/stranger/identity/check" : "/stranger/me", { pass: p });
    if (r.status === 404) return setStep("closed");
    if (r.status === 401) { savePass(null); setPass(null); return setStep("signin"); }
    apply(r.body);
  }, [apply]);

  // On load (and on the way back from Stripe): pick up where this pass left off.
  useEffect(() => {
    if (!pass) return;
    const back = new URLSearchParams(window.location.search).get("stranger") === "identity";
    if (back) setStep("checking");
    void refresh(pass, back);
  }, [pass, refresh]);

  const signIn = async () => {
    setError(null);
    const ma = window.matrixAuth;
    if (!ma?.isLoggedIn()) {
      ma?.showLoginModal();
      setError(ma ? "sign in, then press continue again." : "sign-in isn't available right now.");
      return;
    }
    setBusy(true);
    try {
      const tok = await ma.getOpenIdToken();
      // The meetup card's acknowledgement (host tools). It lives in sessionStorage,
      // so it is still here after the round trip to Stripe Identity.
      const ack = loadAck();
      const r = await call<{ pass?: string; error?: string; card?: unknown }>(
        "/stranger/pass",
        { openIdToken: tok.access_token, meetup, ...(ack ? { ackToken: ack.ackToken } : {}) },
      );
      if (neverBuilt(r.status, r.body)) return setStep("closed");
      const card = r.status === 409 ? asCard(r.body.card) : null;
      if (card && onCardChanged) return onCardChanged(card, () => void signIn());
      if (!r.body.pass) return setError(r.body.error ?? "that didn't work. try again.");
      savePass(r.body.pass);
      setPass(r.body.pass);
      track("stranger_signed_in");
    } catch {
      setError("that didn't work. try again.");
    } finally {
      setBusy(false);
    }
  };

  const consent = async () => {
    if (!pass) return;
    setBusy(true);
    setError(null);
    const r = await call<{ error?: string }>("/stranger/consent", { pass, version: consentVersion });
    setBusy(false);
    if (r.status !== 200) return setError(r.body.error ?? "that didn't save. try again.");
    track("stranger_consented");
    setStep("idcheck");
  };

  const startCheck = async () => {
    if (!pass) return;
    setBusy(true);
    setError(null);
    const r = await call<{ url?: string; error?: string }>("/stranger/identity/start", { pass });
    if (r.body.url) {
      track("stranger_id_check_started");
      window.location.assign(r.body.url);
      return;
    }
    setBusy(false);
    if (r.status === 403) return setStep("minor");
    setError(r.body.error ?? "the ID check didn't open. try again.");
  };

  const back = (
    <button className="btn btn-secondary" onClick={onBack} style={{ marginTop: 12 }}>
      back
    </button>
  );

  if (step === "closed") {
    return (
      <div className="lobby stranger-mode">
        <h1>not open right now</h1>
        <p className="dim">raising a child with someone new only opens during a meetup.</p>
        {back}
      </div>
    );
  }

  if (step === "minor") {
    return (
      <div className="lobby stranger-mode">
        <h1>this one is for adults</h1>
        <p className="dim">raising a child with someone you haven't met is only for people 18 and over.</p>
        <p className="dim">{MINOR_OTHER_WAYS}</p>
        {back}
      </div>
    );
  }

  if (step === "eligible" && pass && prepareOnly) {
    return (
      <div className="lobby stranger-mode" role="status">
        <p>you're ready. when the meetup opens, come back to the same link.</p>
        {back}
      </div>
    );
  }

  if (step === "eligible" && pass) {
    return renderEligible ? <>{renderEligible(pass)}</> : (
      <div className="lobby stranger-mode">
        <h1>you're checked</h1>
        <p className="dim">your age check passed. matching opens soon.</p>
        {back}
      </div>
    );
  }

  if (step === "checking") {
    return (
      <div className="lobby stranger-mode" role="status" aria-live="polite">
        <h1>checking…</h1>
        <p className="dim">reading the result of your ID check.</p>
        {pass && <button className="btn" onClick={() => void refresh(pass, true)}>check again</button>}
        {back}
      </div>
    );
  }

  if (step === "consent") {
    return (
      <div className="lobby stranger-mode stranger-consent">
        <h1>before you meet someone new</h1>
        <p>to keep children out of stranger mode, every player shows an ID and takes a live selfie. no exceptions, including for whoever pays.</p>
        <ul className="dim">
          <li>the check is run by Stripe Identity, our ID-check provider. it compares your face in the selfie with the photo on your ID. that comparison uses biometric data (a face geometry template).</li>
          <li>we ask Stripe one thing: is this person 18 or over? we never store your ID, your selfie, your name or your date of birth.</li>
          <li>once we have the answer we ask Stripe to delete (redact) the check. Stripe may keep some records for a time where the law requires it.</li>
          <li>we keep three things against your account: the answer (18+ or not), so you don't have to show your ID again; the id of Stripe's check, to match Stripe's reply to you and limit how often checks are started; and a coded fingerprint of your ID's number and issuing country, made with a secret key, so one ID can't open two accounts. none of these is biometric data. there's no end date on them yet, and no way yet to ask for them to be deleted.</li>
          <li>if the check says you are under 18, this account can't use stranger mode. solo play and invite play stay open to you.</li>
          <li>the other parent never sees any of this. they only learn that you passed.</li>
        </ul>
        <p className="dim">
          by agreeing you give written consent to the collection and use of your biometric data, as described above, for age verification only.
        </p>
        {error && <p className="error">{error}</p>}
        <button className="btn" onClick={consent} disabled={busy} data-testid="btn-stranger-consent">
          {busy ? "saving…" : "I agree"}
        </button>
        {back}
      </div>
    );
  }

  if (step === "idcheck") {
    return (
      <div className="lobby stranger-mode">
        <h1>show your ID</h1>
        <p className="dim">you'll go to Stripe, take a photo of your ID and a short selfie, and come back here.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn" onClick={startCheck} disabled={busy} data-testid="btn-stranger-idcheck">
          {busy ? "opening…" : "start the ID check"}
        </button>
        {back}
      </div>
    );
  }

  return (
    <div className="lobby stranger-mode">
      <h1>raise a child with someone new</h1>
      <p>you'll be paired with another adult at this meetup, and raise one child together.</p>
      <p className="dim">no profiles, no photos, no swiping. you'll only see each other's choices as parents.</p>
      <p className="dim">it starts with your multiversegames.ai account.</p>
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={signIn} disabled={busy} data-testid="btn-stranger-signin">
        {busy ? "one moment…" : "continue"}
      </button>
      {back}
    </div>
  );
}
