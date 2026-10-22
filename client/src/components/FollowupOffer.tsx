import { useEffect, useState } from "react";
import { track } from "../analytics";
import { getGameSecret, getResearchHint } from "../hooks/gameSecret";
import { looksLikeEmail, saveFollowup, withdrawFollowup } from "../followupClient";

interface Props {
  gameId: string | null;
}

type Stage = "form" | "saved" | "withdrawn" | "hidden";

/**
 * Optional, opt-in follow-up contact, shown after the epilogue to adults in a
 * research game. Hidden unless the stored research hint is explicitly true and
 * the game secret is present: an absent hint (unknown) shows nothing, because
 * this is an extra, never a prompt we are not sure the server will accept.
 *
 * The email lives only in this component's state and the one request body. It
 * is never written to localStorage/sessionStorage and never sent to analytics
 * (track() calls carry no props).
 */
export function FollowupOffer({ gameId }: Props) {
  const secret = gameId ? getGameSecret(gameId) : null;
  const available = !!gameId && !!secret && getResearchHint(gameId) === true;
  const [stage, setStage] = useState<Stage>("form");
  const [contactOk, setContactOk] = useState(false);
  const [aiOk, setAiOk] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (available) track("followup_offer_shown");
  }, [available]);

  if (!available || !gameId || stage === "hidden") return null;

  const canSubmit = contactOk && aiOk && looksLikeEmail(email) && !busy;
  const call = { gameId, secret, base: import.meta.env.BASE_URL, fetchFn: (i: RequestInfo | URL, init?: RequestInit) => fetch(i, init) };

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setMessage(null);
    const result = await saveFollowup({ ...call, email });
    setBusy(false);
    if (result === "saved") {
      setEmail("");
      setStage("saved");
      track("followup_opted_in");
    } else if (result === "unavailable") {
      setStage("hidden");
    } else {
      setMessage("That didn't go through. You can try again, or skip it and carry on.");
    }
  }

  async function withdraw() {
    setBusy(true);
    setMessage(null);
    const result = await withdrawFollowup(call);
    setBusy(false);
    if (result === "failed") {
      setMessage("That didn't go through. You can try again.");
      return;
    }
    setStage("withdrawn");
    track("followup_withdrawn");
  }

  function skip() {
    track("followup_skipped");
    setStage("hidden");
  }

  if (stage === "withdrawn") {
    return (
      <div className="followup-offer" data-testid="followup-withdrawn">
        <p className="followup-line">Done. Your email has been deleted and you won't be contacted.</p>
      </div>
    );
  }

  if (stage === "saved") {
    return (
      <div className="followup-offer" data-testid="followup-saved">
        <p className="followup-line">Thank you. Your email is saved. You can withdraw at any time, and withdrawing deletes it.</p>
        <button type="button" className="btn-link" onClick={withdraw} disabled={busy} data-testid="btn-followup-withdraw">
          withdraw
        </button>
        {message && <p className="followup-error" role="status">{message}</p>}
      </div>
    );
  }

  return (
    <div className="followup-offer" data-testid="followup-offer">
      {/* COPY: pending counsel review */}
      <p className="followup-title">Want to hear from us later? (optional)</p>
      <p className="followup-line">
        If you'd like, we can contact you later with a few follow-up questions. We would keep your email address, along with the
        research answers you already gave during this game. An AI writes the follow-up questions and an AI analyzes the answers.
        This is research. It is not therapy or treatment. You can say no and keep playing.
      </p>
      <p className="followup-line">
        If you're in crisis, call or text 988 in the US, or find a local line at findahelpline.com.
      </p>
      <p className="followup-line">
        You can withdraw at any time using the withdraw button that appears once you've saved, and withdrawing deletes your email.
        See the <a href="privacy.html" target="_blank" rel="noopener">privacy page</a>.
      </p>
      <label className="followup-check">
        <input type="checkbox" checked={contactOk} onChange={(e) => setContactOk(e.target.checked)} data-testid="chk-followup-contact" />
        <span>You may contact me later with follow-up questions.</span>
      </label>
      <label className="followup-check">
        <input type="checkbox" checked={aiOk} onChange={(e) => setAiOk(e.target.checked)} data-testid="chk-followup-ai" />
        <span>I understand the follow-ups are written by an AI and my answers are analyzed by an AI.</span>
      </label>
      <label className="followup-email">
        <span>Email address</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          maxLength={254}
          data-testid="input-followup-email"
        />
      </label>
      <div className="followup-actions">
        <button type="button" className="btn" onClick={submit} disabled={!canSubmit} data-testid="btn-followup-save">
          save my email
        </button>
        <button type="button" className="btn-link" onClick={skip} data-testid="btn-followup-skip">
          Skip
        </button>
      </div>
      {message && <p className="followup-error" role="status">{message}</p>}
    </div>
  );
}
