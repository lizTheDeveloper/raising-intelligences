import { useEffect, useRef, useState } from "react";
import { track } from "../analytics";
import { saveResume } from "../localStore";
import { asCard, type MeetupCard } from "../meetupCard";

const API = import.meta.env.BASE_URL + "api";
const MEETUP_KEY = "ri_stranger_meetup";

async function call<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

type Poll =
  | { status: "waiting"; position: number; count: number }
  | { status: "matched"; gameId: string; slot: string; playerToken: string; partnerName: string }
  | { status: "none" }
  /** Host tools: the meetup closed while waiting (no reason is given). */
  | { status: "ended" }
  /** Host tools: the meetup's card changed while waiting: read it again, then join again. */
  | { status: "card_changed" };

function rememberMeetup(code: string | null): void {
  try { if (code) sessionStorage.setItem(MEETUP_KEY, code); } catch { /* private window */ }
}
function storedMeetup(): string | null {
  try { return sessionStorage.getItem(MEETUP_KEY); } catch { return null; }
}

/** Into the matched game: the seat token becomes the ordinary resume credential. */
function enterGame(gameId: string, playerToken: string): void {
  saveResume(gameId, playerToken);
  window.location.assign(`${import.meta.env.BASE_URL}?game=${encodeURIComponent(gameId)}`);
}

/**
 * Waiting to be paired. No profiles, no photos, no "match" screen: you give a
 * first name and a name for the child, wait, and go straight into the game.
 */
export function StrangerQueue({ pass, meetup, onBack, onCardChanged }: {
  pass: string;
  meetup: string | null;
  onBack: () => void;
  /** A 409 with the meetup's current card: read it again, then `retry` joins with the same names. */
  onCardChanged?: (card: MeetupCard, retry: () => void) => void;
}) {
  const [childName, setChildName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [poll, setPoll] = useState<Poll>({ status: "none" });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const apply = (p: Poll) => {
    if (p.status === "card_changed") {
      setPoll({ status: "none" });
      void (async () => {
        const r = meetup
          ? await fetch(`${API}/events/card?meetup=${encodeURIComponent(meetup)}`).then(async (x) => (x.ok ? asCard((await x.json()).card) : null)).catch(() => null)
          : null;
        if (r && onCardChanged) onCardChanged(r, () => void tryJoin());
        else setPoll({ status: "ended" });
      })();
      return;
    }
    setPoll(p);
    if (p.status === "matched") {
      track("stranger_matched");
      enterGame(p.gameId, p.playerToken);
    }
  };

  // Already queued (a reload, or back from a requeue): pick it up.
  useEffect(() => {
    rememberMeetup(meetup);
    void call<Poll>("/stranger/queue/poll", { pass }).then((r) => r.status === 200 && apply(r.body));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pass]);

  useEffect(() => {
    if (poll.status !== "waiting") return;
    timer.current = setInterval(() => {
      void call<Poll>("/stranger/queue/poll", { pass }).then((r) => r.status === 200 && apply(r.body));
    }, 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.status, pass]);

  const tryJoin = async (): Promise<void> => {
    setError(null);
    const r = await call<Poll & { error?: string; card?: unknown }>("/stranger/queue/join", { pass, childName, displayName });
    const card = r.status === 409 ? asCard(r.body.card) : null;
    if (card && onCardChanged) return onCardChanged(card, () => void tryJoin());
    if (r.status !== 200) return setError(r.body.error ?? "that didn't work. try again.");
    track("stranger_queued");
    apply(r.body);
  };
  const join = (e: React.FormEvent) => {
    e.preventDefault();
    void tryJoin();
  };

  const leave = async () => {
    await call("/stranger/queue/leave", { pass });
    setPoll({ status: "none" });
    onBack();
  };

  if (poll.status === "ended") {
    return (
      <div className="lobby stranger-mode" role="status">
        <h1>this meetup isn't open anymore</h1>
        <p className="dim">nothing was started, and nothing was charged.</p>
        <button className="btn btn-secondary" onClick={() => window.location.assign(import.meta.env.BASE_URL)} style={{ marginTop: 12 }}>back</button>
      </div>
    );
  }

  if (poll.status === "waiting") {
    return (
      <div className="lobby stranger-mode" role="status" aria-live="polite">
        <h1>finding a co-parent…</h1>
        <p className="dim">
          {poll.count <= 1 ? "you're the first one here. someone will join soon." : `${poll.count} people are waiting here.`}
        </p>
        <p className="dim">when you're paired you'll go straight into the game.</p>
        <button className="btn btn-secondary" onClick={leave}>stop looking</button>
      </div>
    );
  }

  if (poll.status === "matched") {
    return (
      <div className="lobby stranger-mode" role="status"><p className="dim">paired. taking you in…</p></div>
    );
  }

  return (
    <div className="lobby stranger-mode">
      <h1>you're checked</h1>
      <p className="dim">you'll be paired with the next adult here. if you're paired with someone who came before you, they'll name the child.</p>
      <form onSubmit={join} className="start-form">
        <input className="name-input" placeholder="your first name" maxLength={30} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <input className="name-input" placeholder="a name for the child" maxLength={40} required value={childName} onChange={(e) => setChildName(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <button className="btn" type="submit" data-testid="btn-stranger-queue">find a co-parent</button>
      </form>
      <button className="btn btn-secondary" onClick={onBack} style={{ marginTop: 12 }}>back</button>
    </div>
  );
}

/** Shown to the one who came, when the match didn't arrive in time. */
export function StrangerNoShow({ gameId, onLeave }: { gameId: string; onLeave: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const requeue = async () => {
    let pass: string | null = null;
    try { pass = sessionStorage.getItem("ri_stranger_pass"); } catch { /* none */ }
    if (!pass) return setError("sign in again to keep looking.");
    const r = await call<Poll & { error?: string }>("/stranger/queue/requeue", { pass, gameId });
    if (r.status !== 200) return setError(r.body.error ?? "that didn't work.");
    track("stranger_requeued");
    if (r.body.status === "matched") return enterGame(r.body.gameId, r.body.playerToken);
    const code = storedMeetup();
    window.location.assign(`${import.meta.env.BASE_URL}?stranger=queue${code ? `&meetup=${encodeURIComponent(code)}` : ""}`);
  };
  return (
    <div className="lobby stranger-mode">
      <h1>they didn't make it</h1>
      <p className="dim">your co-parent didn't arrive in time. nothing was charged.</p>
      {error && <p className="error">{error}</p>}
      <button className="btn" onClick={requeue}>keep looking (you keep your place)</button>
      <button className="btn btn-secondary" onClick={() => { onLeave(); window.location.assign(import.meta.env.BASE_URL); }} style={{ marginTop: 12 }}>
        raise a child on your own instead
      </button>
    </div>
  );
}
