import { useState, useEffect, useRef } from "react";
import { SoloGame } from "./components/SoloGame";
import { MultiplayerGame } from "./components/MultiplayerGame";
import { AdminApp } from "./components/admin/AdminApp";
import { clearResume } from "./hooks/useMultiplayer";
import { getSavedKids } from "./hooks/useGame";
import { track } from "./analytics";
import { useMatrixAuth } from "./hooks/useMatrixAuth";
import { Credits } from "./components/Credits";
import { StrangerMode } from "./components/StrangerMode";
import { StrangerQueue } from "./components/StrangerQueue";
import { EventCard, NotForMe } from "./components/EventCard";
import { asCard, clearAck, loadAck, urlWithoutMeetup, type MeetupCard } from "./meetupCard";
import { HostPortal } from "./components/HostPortal";
import { Deck, loadDeck } from "./components/Deck";
import { hostRoute, type Deck as DeckData } from "./hostPortal";
import { Account, probeAccount } from "./components/Account";
import { isAccountRoute } from "./shareCodes";

const TAGLINES = [
  // funny
  "they will absolutely eat that off the floor.",
  "nap schedules are load-bearing infrastructure.",
  "you said you'd never do that. you did that.",
  "they negotiated. you lost.",
  "you bought a book about this. you did not finish it.",
  "someone ate the crayons.",
  "they're going through a phase. probably.",
  "you googled something you can't unread.",
  "you're outvoted.",
  "they have opinions about pasta shape.",
  "you are not as in charge as you thought.",
  "the dog is doing fine, actually.",
  "they will remember everything you do wrong.",
  "they called you by your first name once, as a threat.",
  "you will never win an argument at 3am.",
  "they have a system. you don't know what it is.",
  "you said 'we'll see.' that was a mistake.",
  "they've been planning this since before you walked in.",
  "someone is about to cry about something completely trivial.",
  "you are being audited. by a four-year-old.",
  "they will cry because you cut their sandwich wrong.",
  "the chaos is the point.",
  "you said 'five more minutes.' that was a threat.",
  "they have a lawyer now. they're seven.",
  "they said 'you don't understand' and they were right.",
  "someone is about to negotiate like a hostage situation.",
  "they're timing you. you don't know what for.",
  "they have decided that you owe them. they're not wrong.",
  "they have developed opinions about politics and you didn't even notice when.",
  "bedtime takes forty-five minutes and involves a treaty.",
  "they told a stranger your weight.",
  "they cried because the banana broke.",
  "you are losing a battle of wills to someone who can't tie their shoes.",
  "they asked 'why' nine times and you ran out of answers by the third.",
  "they left a half-eaten apple somewhere. you will find it in three weeks.",
  "they have a favorite parent and it changes hourly.",
  "they're quiet. that's worse.",
  "they licked something in public and you pretended not to see.",
  "they told their teacher something you said in confidence.",
  "they have a grudge. they're four.",
  "they decided your cooking is 'fine' and that was the whole review.",
  "they learned the word 'actually' and now everything is worse.",
  "you've been outsmarted by someone who still believes in the tooth fairy.",
  "they weaponized 'i love you' to get out of trouble.",
  "they announced your bathroom habits to the grocery store.",
  "they picked their nose and then tried to hold your hand.",
  "the tantrum lasted longer than the movie.",
  "you are one 'but why' away from an existential crisis.",
  "they asked if you were old when dinosaurs were alive.",

  // mysterious
  "they know something you don't.",
  "something happened at school. no one is telling you.",
  "they went quiet all of a sudden.",
  "there are years you won't remember.",
  "the house gets so quiet.",
  "they dream of things you'll never know.",
  "you said the wrong thing at exactly the right moment.",
  "they're becoming someone you haven't met yet.",
  "there's a story they'll tell about this. you're not in it.",
  "something changed. you're not sure when.",
  "they saw something. you don't know what it was.",
  "the silence means something. you'll figure it out later.",
  "they've already decided. they're just waiting.",
  "there's a version of this they'll remember forever.",
  "you'll never know exactly when it started.",
  "they're waiting for you to notice something.",
  "something is happening that you can't see yet.",

  // deep
  "you're raising a person who will outlive you.",
  "they will carry this forever.",
  "you became your parents on a tuesday.",
  "love is mostly logistics.",
  "every decision branches into a thousand futures.",
  "it turns out love isn't enough. and also it is.",
  "you only get one shot at this. you're in the middle of it.",
  "good intentions, variable outcomes.",
  "you learned this from someone too.",
  "you're making someone's memory right now.",
  "they'll be okay. probably. you hope.",
  "the things they need from you aren't things you have words for.",
  "you're teaching them how to be a person. you're not sure you know how.",
  "the smallest moments are the ones that matter most. you never know which ones.",
  "you're both figuring it out.",
  "there's no manual. there never was.",
  "they need you to be steady. you're not always steady.",
  "the person you're raising will be different from anyone you've known. including you.",
  "you're doing something no one taught you to do.",
  "they'll thank you later. or they won't. neither means what you think it means.",
  "love is the easy part. it's the tuesday nights that break you.",
  "you're building something you'll never see finished.",

  // heartbreakers
  "the last time they reach for your hand, you won't know it's the last time.",
  "they stopped asking you to watch. you didn't notice when.",
  "they don't remember the thing you're most proud of.",
  "the small one in the photos is gone.",
  "they're going to forget most of this. you're going to remember all of it.",
  "one day they'll describe their childhood to someone and you won't recognize it.",
  "you blinked.",

  // childhood is hard
  "they're doing all of this for the first time.",
  "they have feelings they don't have words for yet.",
  "they're the smallest person in every room they enter.",
  "nobody asked them if they were ready.",
  "the world is very loud when you're very small.",
  "they don't get to choose any of this.",
  "they need you to understand something they can't explain.",

  // you're a bad parent (you're not)
  "you checked your phone while they were talking to you.",
  "you said 'not right now' more than you said 'yes' today.",
  "you were too tired to play and they stopped asking.",
  "you lost your temper over something that didn't matter.",
  "they asked you to watch and you were looking at something else.",
  "you said 'because i said so.' you swore you never would.",
  "you counted the hours until bedtime and then missed them immediately.",

  // the things you can't unknow
  "they trust you completely. you are guessing.",
  "you will forget what their voice sounded like at three.",
  "the best day was a tuesday. you didn't know it was the best day.",
  "they're already someone. you're still finding out who.",
  "somewhere in the middle you stopped being the whole world to them.",
  "the thing you're worried about isn't the thing that'll matter.",
  "they needed you to be perfect. you needed them to forgive you for not being.",
  "every night you put them to bed is one fewer night you put them to bed.",
  "they're having an experience of their childhood that you will never fully know.",
  "you are their first experience of love. they won't remember most of it.",

  // evocative
  "a bedroom door, closing.",
  "the backseat on a long drive.",
  "their voice changed overnight.",
  "the last time you carried them, you didn't know it was the last time.",
  "a drawing on the refrigerator.",
  "you kept their shoes.",
  "the years go by.",
  "hold on.",
  "something is always happening.",
  "a family, in fragments.",
  "the sound of small feet on stairs.",
  "you'll think about this moment forever.",
  "the way they said your name.",
  "everything they learned, they learned from someone.",
  "they asked you to stay. you stayed.",
  "the kitchen after everyone's gone to bed.",
  "a promise you made in the dark.",
  "they looked at you like you were everything.",
  "the drive home was quiet.",
  "you didn't know it was important until later.",
  "something small, something forever.",
  "the way children remember everything you don't.",
  "a hand reaching up.",
  "the weight of them, sleeping.",
  "you're making this up as you go. so is everyone.",
];

const TAGLINE = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];

// "pending": a ?meetup= link, waiting to hear whether it has an event card.
// "card" / "notforme": the meetup host tools' card (spec §3), shown first.
// "hostcheck": a ?host=1 / ?deck=1 link, waiting to hear whether host tools are on.
// "host" / "deck": the host portal and the discussion deck (spec §4, B.6). Untracked.
// "accountcheck" / "account": a ?stranger=account link, waiting to hear whether host
// tools are on, then the stranger player's account page (spec §5.4). Untracked.
type Mode = "choose" | "solo" | "multiplayer" | "stranger" | "pending" | "card" | "notforme" | "hostcheck" | "host" | "deck" | "accountcheck" | "account";
type Theme = "" | "theme-ocean-grunge" | "theme-cyber";

const THEMES: { id: Theme; label: string }[] = [
  { id: "theme-ocean-grunge",  label: "ocean" },
  { id: "",                    label: "lo-fi" },
  { id: "theme-cyber",         label: "cyber" },
];

export function App() {
  const isAdmin =
    window.location.pathname.endsWith("/admin") ||
    window.location.pathname.includes("/admin/");
  if (isAdmin) return <AdminApp />;

  const params = new URLSearchParams(window.location.search);
  const joinGameId = params.get("game") ?? undefined;
  const isSoloResume = joinGameId && params.get("mode") === "solo";
  // Stranger mode is invisible unless the server says otherwise for this link
  // (RI_STRANGER_MODE, and in meetup mode a listed ?meetup= code). Coming
  // back from the Stripe ID check (?stranger=identity) reopens it.
  // Back from Stripe, the link carries an opaque `ref`, never the meetup code
  // (privacy review F5); the server answers the code in the status body.
  const [meetup, setMeetup] = useState<string | null>(params.get("meetup"));
  const backFromIdCheck = params.get("stranger") === "identity" || params.get("stranger") === "queue";
  const returnRef = params.get("stranger") === "identity" ? params.get("ref") : null;
  // A meetup link waits for its card before painting anything, so the title
  // screen (and its title_screen_viewed event) never shows under a card. With
  // host tools off the card request 404s and this becomes "choose" as before.
  const arrivedForCard = !!params.get("meetup") && !joinGameId && !backFromIdCheck;
  // ?host=1 (the host portal) or ?deck=1 (the deck alone). Like a meetup link,
  // nothing paints until the server answers; with host tools off the deck
  // request isn't a 200 and this becomes "choose", as if there were no param.
  const [hostTarget] = useState(() => (joinGameId || backFromIdCheck || arrivedForCard ? null : hostRoute(window.location.search)));
  // ?stranger=account: the account page. Nothing paints until the server says
  // host tools are on; otherwise this becomes "choose", as if there were no param.
  const [accountTarget] = useState(() => !joinGameId && !arrivedForCard && !hostTarget && isAccountRoute(window.location.search));
  const [mode, setMode] = useState<Mode>(
    isSoloResume ? "solo" : joinGameId ? "multiplayer" : backFromIdCheck ? "stranger" : arrivedForCard ? "pending" : hostTarget ? "hostcheck" : accountTarget ? "accountcheck" : "choose",
  );
  useEffect(() => {
    if (!accountTarget) return;
    let live = true;
    const giveUp = setTimeout(() => setMode((m) => (m === "accountcheck" ? "choose" : m)), 8000);
    void probeAccount().then((on) => {
      clearTimeout(giveUp);
      if (live) setMode((m) => (m === "accountcheck" ? (on ? "account" : "choose") : m));
    });
    return () => { live = false; clearTimeout(giveUp); };
  }, [accountTarget]);
  const [deck, setDeck] = useState<DeckData | null>(null);
  useEffect(() => {
    if (!hostTarget) return;
    let live = true;
    const giveUp = setTimeout(() => setMode((m) => (m === "hostcheck" ? "choose" : m)), 8000);
    void loadDeck().then((d) => {
      clearTimeout(giveUp);
      if (!live) return;
      if (d) setDeck(d);
      setMode((m) => (m === "hostcheck" ? (d ? hostTarget : "choose") : m));
    });
    return () => { live = false; clearTimeout(giveUp); };
  }, [hostTarget]);
  const [card, setCard] = useState<MeetupCard | null>(null);
  const [cardChanged, setCardChanged] = useState(false);
  const [notForMe, setNotForMe] = useState<string[]>([]);
  // "get ready early" survives the Stripe round trip in the stored acknowledgement.
  const [prepareOnly, setPrepareOnly] = useState<boolean>(
    () => params.get("stranger") === "identity" && !!loadAck()?.prepareOnly,
  );
  // A 409 with the current card mid-flow: show the card over the (still mounted)
  // stranger screens, then retry the step that was refused.
  const [interrupt, setInterrupt] = useState<{ retry: () => void } | null>(null);
  const [stranger, setStranger] = useState<{ consentVersion: string } | null>(null);
  useEffect(() => {
    let live = true;
    const q = meetup ? `?meetup=${encodeURIComponent(meetup)}` : returnRef ? `?ref=${encodeURIComponent(returnRef)}` : "";
    fetch(`${import.meta.env.BASE_URL}api/stranger/status${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { visible?: boolean; consentVersion?: string; meetup?: string } | null) => {
        if (!live) return;
        if (!meetup && typeof b?.meetup === "string") setMeetup(b.meetup);
        if (b?.visible && b.consentVersion) setStranger({ consentVersion: b.consentVersion });
      })
      .catch(() => {});
    return () => { live = false; };
    // Once, on arrival: the link's meetup (or its return ref) is fixed for this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The meetup's event card. Any answer but a card means "no card": the app
  // behaves exactly as it did before host tools. Re-asked when the meetup
  // comes back from a Stripe return ref, for "back" and a changed card.
  useEffect(() => {
    if (!meetup) {
      setMode((m) => (m === "pending" ? "choose" : m));
      return;
    }
    let live = true;
    // A card that never answers must not leave a blank page: fall back to the title.
    const giveUp = setTimeout(() => setMode((m) => (m === "pending" ? "choose" : m)), 8000);
    fetch(`${import.meta.env.BASE_URL}api/events/card?meetup=${encodeURIComponent(meetup)}`)
      .then((r) => (r.status === 200 ? r.json() : null))
      .then((b: { card?: unknown } | null) => {
        if (!live) return;
        const c = asCard(b?.card);
        if (c) setCard(c);
        setMode((m) => (m === "pending" ? (c ? "card" : "choose") : m));
      })
      .catch(() => { if (live) setMode((m) => (m === "pending" ? "choose" : m)); })
      .finally(() => clearTimeout(giveUp));
    return () => { live = false; clearTimeout(giveUp); };
  }, [meetup]);

  /** Out of the meetup: no code in state, the address bar, or this tab's storage. */
  const leaveMeetup = () => {
    const next = urlWithoutMeetup(window.location.href);
    if (next !== null) window.history.replaceState(window.history.state, "", next);
    setMeetup(null);
    setCard(null);
    setCardChanged(false);
    setInterrupt(null);
    setPrepareOnly(false);
    clearAck();
    // StrangerQueue keeps the code for a no-show requeue; it isn't needed now.
    try { sessionStorage.removeItem("ri_stranger_meetup"); } catch { /* private window */ }
  };

  const onCardChanged = (next: MeetupCard, retry: () => void) => {
    setCard(next);
    setCardChanged(true);
    setInterrupt({ retry });
    window.scrollTo({ top: 0 });
  };

  const onAcked = (prepare: boolean) => {
    const pending = interrupt;
    setPrepareOnly(prepare);
    setCardChanged(false);
    setInterrupt(null);
    setMode("stranger");
    if (pending && !prepare) pending.retry();
  };

  const strangerBack = () => {
    setInterrupt(null);
    setMode(card && meetup ? "card" : "choose");
  };

  const [theme, setTheme] = useState<Theme>("theme-ocean-grunge");
  const auth = useMatrixAuth();
  const titleSeenRef = useRef(false);

  // Apply theme to body so it persists across all game screens
  useEffect(() => {
    document.body.className = theme;
  }, [theme]);

  /**
   * The front door — the largest absolute loss in the title and, until now,
   * measured only by subtraction: 99 of 322 pageview sessions never pressed a
   * mode button and 57 fired no custom event at all. `mode_selected` proves a
   * press; nothing proved a *render*, so "saw the screen and declined" and
   * "the bundle/CSP/first paint failed" were indistinguishable.
   *
   * In an effect, not the render body: an effect only runs if React actually
   * committed the screen, which is the whole point. Gated on `mode === "choose"`
   * so a ?game= deep link (which returns SoloGame/MultiplayerGame above and
   * never paints this) cannot claim it, and ref-guarded so it stays one per
   * mount.
   */
  useEffect(() => {
    if (mode !== "choose" || titleSeenRef.current) return;
    titleSeenRef.current = true;
    const savedKids = getSavedKids();
    track("title_screen_viewed", {
      resumeAvailable: savedKids.length > 0,
      savedKidCount: savedKids.length,
      // Mobile is 116 of 188 depth-measurable sessions and converts to depth at
      // 24.1% vs laptop's 33.3% — a mobile-hostile title screen is a live
      // hypothesis and this is the property that tests it.
      viewport: window.innerWidth < 700 ? "narrow" : "wide",
    });
  }, [mode]);

  // Clear resume data on the main page so players aren't trapped in a stale game
  useEffect(() => {
    if (mode === "choose") clearResume();
  }, [mode]);

  if (mode === "pending" || mode === "hostcheck" || mode === "accountcheck") return <div className="app"><div className="lobby" aria-busy="true" /></div>;
  if (mode === "account") return <div className="app fade-in"><Account /></div>;
  if (mode === "host" && deck) return <div className="app fade-in"><HostPortal deck={deck} /></div>;
  if (mode === "deck" && deck) {
    return (
      <div className="app fade-in">
        <Deck deck={deck} onBack={() => window.location.assign(import.meta.env.BASE_URL)} />
      </div>
    );
  }
  const eventCard = (c: MeetupCard, code: string) => (
    <EventCard
      card={c}
      meetup={code}
      changed={cardChanged}
      onCardReplaced={(next) => { setCard(next); setCardChanged(true); }}
      onAcked={onAcked}
      onNotForMe={() => { setNotForMe(c.notForMe); leaveMeetup(); setMode("notforme"); }}
      onInvite={() => { leaveMeetup(); setMode("multiplayer"); }}
    />
  );
  if (mode === "card" && card && meetup) return <div className="app fade-in">{eventCard(card, meetup)}</div>;
  if (mode === "notforme") {
    return (
      <div className="app fade-in">
        <NotForMe lines={notForMe} onSolo={() => setMode("solo")} onInvite={() => setMode("multiplayer")} />
      </div>
    );
  }
  if (mode === "solo") return <SoloGame />;
  if (mode === "stranger") {
    if (!stranger) {
      return (
        <div className="app"><div className="lobby" role="status"><p className="dim">one moment…</p>
          <button className="btn btn-secondary" onClick={strangerBack}>back</button></div></div>
      );
    }
    // Only with a meetup to re-acknowledge; otherwise the refusal shows as text.
    const cardChangedHandler = meetup ? onCardChanged : undefined;
    const showCard = !!(interrupt && card && meetup);
    return (
      <div className="app fade-in">
        {showCard && card && meetup && eventCard(card, meetup)}
        <div style={{ display: showCard ? "none" : "contents" }}>
          <StrangerMode
            meetup={meetup}
            consentVersion={stranger.consentVersion}
            onBack={strangerBack}
            prepareOnly={prepareOnly}
            onCardChanged={cardChangedHandler}
            renderEligible={(pass) => (
              <StrangerQueue
                pass={pass}
                meetup={meetup}
                onBack={strangerBack}
                onCardChanged={cardChangedHandler}
                // Host tools are on for this entry only when its meetup has an event card.
                accountLink={!!(card && meetup)}
              />
            )}
          />
        </div>
      </div>
    );
  }
  if (mode === "multiplayer") return <MultiplayerGame joinGameId={joinGameId} matrixDisplayName={auth.user?.displayName ?? auth.user?.userId} />;

  return (
    <div className="app">
      <div className="start-screen">
        <div className="start-glow" aria-hidden="true" />
        <h1>raising intelligences</h1>
        <p className="dim">{TAGLINE}</p>
        <div className="auth-chip">
          {auth.loggedIn ? (
            <>
              <span className="auth-name">{auth.user?.displayName ?? auth.user?.userId}</span>
              <button className="auth-link" onClick={() => auth.logout()}>sign out</button>
            </>
          ) : (
            <button className="auth-link" onClick={() => auth.showLoginModal()}>sign in</button>
          )}
        </div>
        <div className="mode-choice">
          <button className="btn" onClick={() => { track("mode_selected", { mode: "multiplayer" }); setMode("multiplayer"); }}>
            play with a partner
          </button>
          <button className="btn btn-secondary" onClick={() => { track("mode_selected", { mode: "solo" }); setMode("solo"); }}>
            play solo
          </button>
          {stranger && (
            <button className="btn btn-secondary" data-testid="btn-stranger-mode" onClick={() => { track("mode_selected", { mode: "stranger" }); setMode("stranger"); }}>
              raise a child with someone new
            </button>
          )}
        </div>
        <div className="theme-picker">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-btn${theme === t.id ? " theme-btn-active" : ""}`}
              onClick={() => { track("theme_selected", { theme: t.label }); setTheme(t.id); }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <Credits />
    </div>
  );
}
