import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ChildPortrait } from "./ChildPortrait";
import { track } from "../analytics";
import { getWeightedFragments } from "../data/child-fragments";

const INTRO_VARIANTS = 6;

// ---------- OCEAN quiz data ----------
interface QuizOption {
  text: string;
  value: number;
}

interface QuizQuestion {
  prompt: string;
  options: QuizOption[];
}

const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    prompt:
      "You find out a friend is really into something you’ve never heard of — fermentation, birdwatching, speedcubing, whatever. You:",
    options: [
      { text: "Smile and nod. You’re happy for them but you’ll stick to what you know.", value: 1 },
      { text: "Ask a couple questions to be polite, but you probably won’t look into it.", value: 2 },
      { text: "Go down a rabbit hole that night reading about it.", value: 3 },
      { text: "Show up next weekend with your own starter kit.", value: 4 },
    ],
  },
  {
    prompt: "You’ve got a free Saturday with nothing planned. You:",
    options: [
      { text: "Wake up whenever, see where the day takes you.", value: 1 },
      { text: "Have a loose idea — maybe errands, maybe not.", value: 2 },
      { text: "Knock out your to-do list in the morning so you can relax later.", value: 3 },
      { text: "Already blocked it out on Thursday. Groceries, gym, that thing you’ve been putting off.", value: 4 },
    ],
  },
  {
    prompt: "You’re at a party where you only know the host. You:",
    options: [
      { text: "Find the dog or the bookshelf. Leave early. Recharge for three days.", value: 1 },
      { text: "Stick near the host, have a couple conversations, leave at a reasonable hour.", value: 2 },
      { text: "End up in a good conversation with a stranger, stay later than planned.", value: 3 },
      { text: "Leave with four new phone numbers and plans for next weekend.", value: 4 },
    ],
  },
  {
    prompt: "Your coworker takes credit for an idea you pitched last week. You:",
    options: [
      { text: "Call it out in the next meeting. Credit matters and they know what they did.", value: 1 },
      { text: "Mention it to them privately — firm but not aggressive.", value: 2 },
      { text: "Let it go this time but keep an eye on it. Not worth the conflict.", value: 3 },
      { text: "Honestly, you’re just glad the idea is moving forward. Who cares who gets credit.", value: 4 },
    ],
  },
  {
    prompt: "You send a text to a close friend and they don’t respond for two days. You:",
    options: [
      { text: "Assume they’re busy. Check in if you don’t hear back by the weekend.", value: 1 },
      { text: "Notice it, but figure they’ll get back to you when they can.", value: 2 },
      { text: "Scroll back through your last few messages wondering if you said something weird.", value: 3 },
      { text: "Replay the conversation in your head at 2am. Definitely said something wrong.", value: 4 },
    ],
  },
];

// ---------- Pacing ----------
// "All the narrative pacing was 100% to cover up scene generation and was never
// supposed to take long on purpose." (docs/playtest-notes.md, design principle.)
//
// So none of the beats below are scheduled. Each one is the *floor* its own
// written line needs to be readable, and the beats that actually cover work end
// the moment that work lands:
//
//   narrative / transition — nothing to await; the floor IS the duration, and
//                            it is derived from the line so editing the prose
//                            re-times the beat instead of desynchronising it
//                            from a hand-picked constant.
//   reveal                 — covers the child-portrait call: floor, then advance
//                            as soon as the portrait has loaded.
//   waiting                — covers the personality-seed call and (since the
//                            reorder) scene-1 generation: `canBegin`.
//
// This replaced a fixed 1200/2400/1600/1600/2500ms ladder — ~14.9s that ran the
// same length whether the work behind it took 2s or 40s.

/** ms per word at a comfortable reading pace, plus a fixed beat to register the line. */
const READ_MS_PER_WORD = 180;
const READ_BASE_MS = 300;
/** Floors are clamped so a three-word line still lands and a long one doesn't drag. */
const READ_MIN_MS = 800;
const READ_MAX_MS = 1800;

function readableMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(READ_MAX_MS, Math.max(READ_MIN_MS, READ_BASE_MS + words * READ_MS_PER_WORD));
}

/** Extra on a beat that also swaps the age background, so the crossfade lands. */
const AGE_CROSSFADE_MS = 250;

/** Minimum time on the reveal, so the portrait appearing actually registers. */
const REVEAL_FLOOR_MS = 900;
/**
 * Ceiling on waiting for the portrait.
 *
 * `portraitReady` comes from the <img> onLoad. A 404, a disabled portrait
 * pipeline, or a blocked request means it never fires — and a purely
 * generation-driven reveal would then hang forever, which is strictly worse
 * than the fixed timer it replaced. Generation-driven needs a ceiling as much
 * as a floor.
 */
const PORTRAIT_MAX_WAIT_MS = 4000;

// ---------- Step sequence ----------
// Narrative, transition and reveal beats advance on their own and can be
// skipped ahead with a click — they are pacing, never a gate. Only quiz,
// confessional and waiting steps require the player to act: answering,
// submitting, and the co-parent handshake respectively. Nothing on this screen
// asks the player to "ready up" before they may begin.

type StepKind = "narrative" | "quiz" | "transition" | "reveal" | "confessional" | "waiting";

interface Step {
  kind: StepKind;
  /** For narrative: the text to display. */
  text?: string;
  /** For narrative: which intro age (0/1/2) — drives the background image. */
  age?: number;
  /** For quiz: the quiz index (0-4). */
  quizIndex?: number;
}

const STEPS: Step[] = [
  // Beat 1 (age 0)
  { kind: "narrative", text: "born on a quiet night.", age: 0 },
  { kind: "narrative", text: "so small you were afraid to breathe.", age: 0 },
  // Q1 Openness
  { kind: "quiz", quizIndex: 0 },
  // Beat 2 (age 1)
  { kind: "narrative", text: "they reached for everything.", age: 1 },
  { kind: "narrative", text: "they said something that almost sounded like your name.", age: 1 },
  // Q2 Conscientiousness
  { kind: "quiz", quizIndex: 1 },
  // Beat 3 (age 2)
  { kind: "narrative", text: "they took their first steps.", age: 2 },
  { kind: "narrative", text: "they fell. they got back up.", age: 2 },
  // Q3 Extraversion
  { kind: "quiz", quizIndex: 2 },
  // Transition
  { kind: "transition", text: "three years old." },
  // Q4 Agreeableness
  { kind: "quiz", quizIndex: 3 },
  // Q5 Neuroticism
  { kind: "quiz", quizIndex: 4 },
  // Portrait reveal
  { kind: "reveal" },
  // Confessional prompts
  { kind: "confessional" },
  // Waiting for seed + event
  { kind: "waiting" },
];

/**
 * The closing beat, and the last index that exists.
 *
 * Load-bearing, not decorative: `handleConfessionalSubmit` ends by advancing a
 * step, and the retry calls it *from* the waiting step — so an unclamped
 * advance puts `stepIndex` off the end of STEPS, and `displayAge` walks
 * `STEPS[i]` backwards from `stepIndex`. That is a render crash, not a no-op,
 * which is why the retry button that already shipped on the solo path has never
 * worked.
 */
const LAST_STEP = STEPS.length - 1;

// ---------- Props ----------
interface Props {
  childName: string;
  gameId: string | null;
  eventReady: boolean;
  onReady: () => void;
  /** Multiplayer: emit personality via socket instead of REST POST. */
  onSubmitPersonality?: (payload: { ocean: number[]; confessional1?: string; confessional2?: string }) => void;
  /** Multiplayer: combined seed is ready (from socket event). */
  seedReadyProp?: boolean;
  /**
   * Multiplayer: has the co-parent finished their own quiz? Read off STATE, so
   * it is right after a reconnect too.
   *
   * Only used to describe the wait honestly. Between your submit and theirs,
   * nothing is generating — the seed call needs both answer sets before it can
   * start. Undefined on the solo path, which has no co-parent to wait for.
   */
  partnerSubmitted?: boolean;
  /** Multiplayer: the co-parent's display name, for that same line. Already
   * defaulted to "your partner" by the caller; the fallback here is belt-and-
   * braces and uses the same word, so the game never has two names for them. */
  partnerName?: string;
  /**
   * Solo: the personality seed has been generated server-side. This is the
   * signal to start building scene 1 — the seed has to exist first, or the
   * world manager generates the opening scene knowing nothing about the parent.
   * Multiplayer does the equivalent server-side, off SUBMIT_PERSONALITY.
   */
  onSeedReady?: () => void;
  /**
   * Multiplayer: the server's player-facing account of why the opening failed,
   * broadcast to BOTH parents (handlers.ts, the SUBMIT_PERSONALITY catch).
   *
   * The opening is two model calls — the personality seed, then scene 1 — and
   * either can time out at 90s. Both parents are on this screen's closing beat
   * when it happens, so both are told, and either can retry.
   */
  error?: string | null;
  /**
   * Multiplayer: drop that error. Called as a submit goes out, so the surface
   * below can only ever be describing *this* attempt.
   */
  onClearError?: () => void;
}

function pickVariant(): number {
  return Math.floor(Math.random() * INTRO_VARIANTS);
}

// ---------- Component ----------
export function GuardianScreen({ childName, gameId, eventReady, onReady, onSubmitPersonality, seedReadyProp, partnerSubmitted, partnerName, onSeedReady, error, onClearError }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [narrativeLines, setNarrativeLines] = useState<string[]>([]);
  const [oceanAnswers, setOceanAnswers] = useState<number[]>([]);
  const [confessional1, setConfessional1] = useState("");
  const [confessional2, setConfessional2] = useState("");
  const [portraitReady, setPortraitReady] = useState(false);
  const [seedReady, setSeedReady] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedSubmitting, setSeedSubmitting] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  /** Reveal beat: its readable floor has elapsed. */
  const [revealFloorDone, setRevealFloorDone] = useState(false);
  /** Reveal beat: we've waited as long as we're willing to for the portrait. */
  const [portraitWaitOver, setPortraitWaitOver] = useState(false);

  // Fragment list — accumulates up to 10, fade-in + append style
  const [visibleFragments, setVisibleFragments] = useState<string[]>([]);
  const fragmentPoolUsed = useRef(new Set<number>());
  // Keep the (bounded, scrollable) phrase area pinned to the newest line so the
  // cute fragments auto-scroll instead of pushing the ready button off-screen.
  const thoughtsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = thoughtsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleFragments]);

  const variant = useMemo(pickVariant, []);
  const base = import.meta.env.BASE_URL;

  // Guard against double-firing the personality POST (React strict mode)
  const personalitySubmitted = useRef(false);

  const currentStep = STEPS[stepIndex] ?? STEPS[STEPS.length - 1];

  // ---------- Weighted fragment pool ----------
  const weightedFragments = useMemo(() => getWeightedFragments(oceanAnswers), [oceanAnswers]);

  // Append a new fragment every few seconds, up to 10 visible
  useEffect(() => {
    if (weightedFragments.length === 0) return;

    const pickNext = () => {
      const available = weightedFragments
        .map((f, i) => ({ text: f.text, idx: i }))
        .filter((f) => !fragmentPoolUsed.current.has(f.idx));
      if (available.length === 0) {
        fragmentPoolUsed.current.clear();
        return weightedFragments[Math.floor(Math.random() * weightedFragments.length)];
      }
      const pick = available[Math.floor(Math.random() * available.length)];
      fragmentPoolUsed.current.add(pick.idx);
      return pick;
    };

    // Seed with one fragment immediately
    if (visibleFragments.length === 0) {
      const first = pickNext();
      setVisibleFragments([first.text]);
    }

    const id = setInterval(() => {
      setVisibleFragments((prev) => {
        const next = pickNext();
        return [...prev, next.text];
      });
    }, 8000);
    return () => clearInterval(id);
  }, [weightedFragments]);

  // ---------- Current display age for intro images ----------
  const displayAge = useMemo(() => {
    // Walk backwards from current step to find the most recent age
    for (let i = stepIndex; i >= 0; i--) {
      // Optional chaining, not tidiness: `stepIndex` can legitimately sit at
      // LAST_STEP while a clamped advance is requested, and any future off-end
      // index must degrade to the last known age rather than throw mid-render.
      if (STEPS[i]?.age !== undefined) return STEPS[i]!.age!;
    }
    return 0;
  }, [stepIndex]);

  const portraitRevealed = currentStep.kind === "reveal" ||
    currentStep.kind === "confessional" ||
    currentStep.kind === "waiting";

  // ---------- Advance the written beats ----------
  // Narrative and transition beats cover no outstanding call of their own — the
  // portrait is awaited at the reveal and the seed at the waiting step — so
  // their readable floor is the whole duration. Nothing here is a schedule.
  useEffect(() => {
    if (currentStep.kind !== "narrative" && currentStep.kind !== "transition") return;

    // Add the line to the narrative display
    if (currentStep.text) {
      setNarrativeLines((prev) => {
        if (prev[prev.length - 1] === currentStep.text) return prev;
        return [...prev, currentStep.text!];
      });
    }

    const isNewAge = stepIndex > 0 && currentStep.age !== undefined &&
      STEPS[stepIndex - 1]?.age !== currentStep.age;
    const floor = readableMs(currentStep.text ?? "") + (isNewAge ? AGE_CROSSFADE_MS : 0);

    const timer = setTimeout(() => setStepIndex((i) => i + 1), floor);
    return () => clearTimeout(timer);
  }, [stepIndex, currentStep]);

  // ---------- Reveal: generation-driven, floored and capped ----------
  // This beat exists to cover the child-portrait call, so it ends when the
  // portrait lands — not on a stopwatch. The floor keeps the reveal from
  // flashing past when the image is already cached; the ceiling keeps a portrait
  // that never loads from stranding the player on a beat with no exit.
  useEffect(() => {
    if (currentStep.kind !== "reveal") return;
    const floor = setTimeout(() => setRevealFloorDone(true), REVEAL_FLOOR_MS);
    const ceiling = setTimeout(() => setPortraitWaitOver(true), PORTRAIT_MAX_WAIT_MS);
    return () => {
      clearTimeout(floor);
      clearTimeout(ceiling);
    };
  }, [currentStep.kind]);

  useEffect(() => {
    if (currentStep.kind !== "reveal") return;
    if (!revealFloorDone) return;
    if (!portraitReady && !portraitWaitOver) return;
    setStepIndex((i) => i + 1);
  }, [currentStep.kind, revealFloorDone, portraitReady, portraitWaitOver]);

  // ---------- Skip ahead through the timed beats ----------
  // Timed beats are pacing, not gates: a click advances them early instead of
  // being required to advance them at all. Quiz / confessional / waiting steps
  // are deliberately not skippable — a stray click must never answer a
  // question for the player or jump the co-parent handshake.
  const isSkippable =
    currentStep.kind === "narrative" ||
    currentStep.kind === "transition" ||
    currentStep.kind === "reveal";

  const skipAhead = useCallback(() => {
    const step = STEPS[stepIndex];
    if (!step) return;
    if (step.kind !== "narrative" && step.kind !== "transition" && step.kind !== "reveal") return;
    // Record the line even if the auto-advance timer never got to it, so
    // skipping never drops a beat from the accumulated narrative.
    if (step.text) {
      setNarrativeLines((prev) =>
        prev[prev.length - 1] === step.text ? prev : [...prev, step.text!]
      );
    }
    // Guard against advancing twice if the timer fired between render and click.
    setStepIndex((i) => (i === stepIndex ? i + 1 : i));
  }, [stepIndex]);

  useEffect(() => {
    if (!isSkippable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        skipAhead();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isSkippable, skipAhead]);

  // ---------- Quiz answer handler ----------
  const handleQuizAnswer = useCallback((quizIndex: number, value: number) => {
    setOceanAnswers((prev) => {
      const next = [...prev];
      next[quizIndex] = value;
      return next;
    });
    // Brief pause then advance
    setTimeout(() => setStepIndex((i) => i + 1), 400);
  }, []);

  // ---------- Confessional submit ----------
  const handleConfessionalSubmit = useCallback(async () => {
    if (!gameId || personalitySubmitted.current) return;
    personalitySubmitted.current = true;
    setSeedSubmitting(true);
    setSeedError(null);

    // Multiplayer path: emit via socket, seed arrives via PERSONALITY_SEED_READY event
    if (onSubmitPersonality) {
      // Anything already on `error` belongs to something else — a refused
      // handoff code back in the lobby, say — and would otherwise be rendered
      // by the waiting step below under a "try again" that has nothing to do
      // with it. Clearing as the submit goes out means the surface can only
      // ever show a failure of this attempt, and makes a repeat of the same
      // message visibly land instead of being a no-op re-render.
      onClearError?.();
      onSubmitPersonality({ ocean: oceanAnswers, confessional1, confessional2 });
      setSeedSubmitting(false);
      track("personality_submitted", { mode: "multiplayer" });
      setStepIndex((i) => Math.min(i + 1, LAST_STEP));
      return;
    }

    // Solo path: REST POST
    try {
      const res = await fetch(`${base}api/game/${gameId}/personality`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ocean: oceanAnswers,
          confessional1,
          confessional2,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status}${body ? ` — ${body}` : ""}`);
      }

      const data = await res.json();
      if (data.ready) {
        setSeedReady(true);
        track("personality_submitted", { seedReady: true });
        // Scene 1 starts HERE, not at game creation — the world manager has to
        // see the seed. Multiplayer does the same thing server-side, off
        // SUBMIT_PERSONALITY.
        onSeedReady?.();
      }
    } catch (err) {
      personalitySubmitted.current = false;
      setSeedError(err instanceof Error ? err.message : String(err));
      track("personality_error");
    } finally {
      setSeedSubmitting(false);
    }

    // Advance to waiting step — clamped, because the retry below re-enters this
    // function from the waiting step and must not walk off the end of STEPS.
    setStepIndex((i) => Math.min(i + 1, LAST_STEP));
  }, [gameId, oceanAnswers, confessional1, confessional2, base, onSubmitPersonality, onSeedReady, onClearError]);

  // ---------- Retry the opening ----------
  // The recovery is literally "submit the personality again", on both paths:
  // solo re-POSTs, multiplayer re-emits SUBMIT_PERSONALITY. Server-side that
  // re-runs the seed and (because startFirstScene deletes its own guard on
  // failure) scene 1, from personalities that are still in state. Nothing here
  // is a placeholder — the answers this resubmits are the ones held in this
  // component, and reaching the waiting step is what proves they are complete.
  const handleRetry = useCallback(() => {
    setSeedError(null);
    personalitySubmitted.current = false;
    handleConfessionalSubmit();
  }, [handleConfessionalSubmit]);

  // ---------- Ready handler ----------
  const handleNotReady = () => {
    track("guardian_not_ready");
    setShowMessage(true);
  };

  // In multiplayer, seedReady comes from the prop (socket event); in solo, from internal state (REST response)
  const effectiveSeedReady = onSubmitPersonality ? !!seedReadyProp : seedReady;
  /**
   * The closing beat now DOES gate on the event, and that is the point.
   *
   * It used not to, because scene 1 had already been generated before this
   * screen ever appeared — waiting here would have been waiting for nothing, so
   * the wait was pushed out to a bare "building the next scene…" spinner
   * instead. Since the reorder, submitting the confessionals is what starts
   * scene-1 generation, and this screen is the content that covers it: the
   * portrait reveal and the "I'm ready" / "most people aren't" exchange play
   * over the call rather than after it.
   *
   * There is an exit if generation fails, and it is on this screen: see
   * `failure` below. It used to be the server clearing the ready flags, which
   * dropped both clients back to the lobby — losing the quiz — and that is
   * exactly what the fix removed.
   */
  const canBegin = effectiveSeedReady && portraitRevealed && eventReady;

  /**
   * The one failure surface, fed by whichever path this screen is on.
   *
   * Solo's `seedError` holds the raw fetch failure and is deliberately not
   * shown — the player gets a written line instead. Multiplayer's `error` is
   * already written for a player when it leaves the server, so it is shown as
   * sent; the two never both apply, because `seedError` is only ever set on the
   * solo branch of the submit.
   */
  const failure = seedError
    ? "something went wrong generating their personality."
    : error ?? null;

  // ---------- Render ----------
  return (
    <div className="guardian-screen">
      <h2 className="guardian-name">{childName}</h2>

      <div className="guardian-figure">
        {[0, 1, 2].map((age) => (
          <div
            key={age}
            className={`guardian-intro-image${
              !portraitRevealed && displayAge === age ? " guardian-intro-visible" : ""
            }`}
          >
            <img
              src={`${base}portraits/intro/age-${age}-${variant}.jpg`}
              alt=""
              aria-hidden="true"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
          </div>
        ))}

        <div
          className={`guardian-portrait-wrap${
            portraitRevealed && portraitReady ? " guardian-portrait-revealed" : ""
          }`}
        >
          <ChildPortrait
            age={3}
            size={200}
            gameId={gameId}
            onLoad={() => setPortraitReady(true)}
          />
        </div>
      </div>

      {/* Accumulated narrative lines */}
      <div className="guardian-loading-lines">
        {narrativeLines.map((line, i) => (
          <p key={i} className="guardian-line">
            {line}
          </p>
        ))}
      </div>

      {/* Quiz question */}
      {currentStep.kind === "quiz" && currentStep.quizIndex !== undefined && (
        <div className="guardian-quiz" key={`quiz-${currentStep.quizIndex}`}>
          <p className="guardian-quiz-prompt">
            {QUIZ_QUESTIONS[currentStep.quizIndex].prompt}
          </p>
          <div className="guardian-quiz-options">
            {QUIZ_QUESTIONS[currentStep.quizIndex].options.map((opt, i) => (
              <button
                key={i}
                className={`btn guardian-quiz-option${
                  oceanAnswers[currentStep.quizIndex!] === opt.value
                    ? " guardian-quiz-selected"
                    : ""
                }`}
                data-testid={`quiz-option-${currentStep.quizIndex}-${i}`}
                onClick={() => handleQuizAnswer(currentStep.quizIndex!, opt.value)}
              >
                {opt.text}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Confessional prompts — kid portrait visible */}
      {currentStep.kind === "confessional" && (
        <div className="guardian-confessional">
          <div className="guardian-confessional-field">
            <label className="guardian-confessional-label">
              What&rsquo;s the most evil thing you did as a kid (ages 3-7)?
            </label>
            <textarea
              className="guardian-confessional-input"
              placeholder="I told my sister her hamster ran away. It didn't run away."
              maxLength={500}
              value={confessional1}
              onChange={(e) => setConfessional1(e.target.value)}
              rows={3}
            />
            <span className="guardian-char-count">{confessional1.length}/500</span>
          </div>

          <div className="guardian-confessional-field">
            <label className="guardian-confessional-label">
              What&rsquo;s one thing you never told your parents?
            </label>
            <textarea
              className="guardian-confessional-input"
              placeholder="I failed a class sophomore year and forged the report card."
              maxLength={500}
              value={confessional2}
              onChange={(e) => setConfessional2(e.target.value)}
              rows={3}
            />
            <span className="guardian-char-count">{confessional2.length}/500</span>
          </div>

          <button
            className="btn guardian-confessional-submit"
            onClick={handleConfessionalSubmit}
            disabled={seedSubmitting}
          >
            {seedSubmitting ? "generating..." : "submit"}
          </button>
        </div>
      )}

      {/* Child fragments — fade in and accumulate, up to 10 */}
      {(currentStep.kind === "quiz" ||
        currentStep.kind === "reveal" ||
        currentStep.kind === "confessional" ||
        currentStep.kind === "waiting") &&
        visibleFragments.length > 0 && (
          <div className="guardian-thoughts" ref={thoughtsRef}>
            {visibleFragments.map((text, i) => (
              <span key={`${text}-${i}`} className="guardian-thought">
                {text}
              </span>
            ))}
          </div>
        )}

      {/* Waiting state — sticky footer so loading + readiness are always in view.

          The error surface lives here, on the closing beat, and nowhere else on
          this screen. That is not a layout preference: the waiting step is the
          only one reachable by submitting, so it is the only one where "try
          again" has answers to resubmit. It is also the only step with no skip
          overlay mounted (`isSkippable` excludes it), so the button below can
          never be swallowed by one — and no error can ever put a control under
          a stray click that would answer a quiz question or jump the co-parent
          handshake. `.guardian-footer` is z-index 5, above both the overlay's 2
          and the floated handoff control's 3, so the stacking holds even if a
          future step mounts the overlay here — and the handoff control is
          anchored top-right, clear of this footer either way. */}
      {currentStep.kind === "waiting" && (
        <div className="guardian-footer">
          {failure ? (
            <div className="guardian-seed-error" role="alert">
              <p className="dim">{failure}</p>
              <button className="btn dim" data-testid="btn-guardian-retry" onClick={handleRetry}>
                try again
              </button>
            </div>
          ) : canBegin ? (
            <div className="guardian-buttons">
              <button
                className="btn"
                data-testid="btn-guardian-ready"
                onClick={() => {
                  track("guardian_accepted");
                  onReady();
                }}
              >
                I'm ready
              </button>
              {!showMessage ? (
                <button
                  className="btn dim"
                  data-testid="btn-guardian-not-ready"
                  onClick={handleNotReady}
                >
                  I'm not ready
                </button>
              ) : (
                <p className="guardian-not-ready-message">most people aren't</p>
              )}
            </div>
          ) : (
            <div className="guardian-waiting-indicator" role="status" aria-live="polite">
              <div className="guardian-spinner" aria-hidden="true">
                <span></span><span></span><span></span>
              </div>
              {/* Three distinct waits, named honestly — and only one of them is
                  ever a generation. Keyed off the work itself rather than off
                  `seedSubmitting`, which only ever goes true on the solo path.

                  1. Your co-parent hasn't finished their own quiz. NOTHING is
                     being generated: the seed needs both answer sets before the
                     call can start. Claiming otherwise was the one progress
                     message in the opening that was simply false. Multiplayer
                     only — `partnerSubmitted` is undefined solo.
                  2. Both answered; the seed is being generated.
                  3. Seed done; scene 1 is being generated. */}
              <p className="guardian-loading-hint">
                {partnerSubmitted === false
                  ? `${partnerName ?? "your partner"} is still answering…`
                  : !effectiveSeedReady
                  ? "shaping who they'll become…"
                  : "getting your story ready…"}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Timed beats can be clicked past. They advance on their own regardless —
          this is an accelerator, not a gate. */}
      {isSkippable && (
        <button
          type="button"
          className="guardian-skip-overlay"
          data-testid="btn-guardian-skip"
          aria-label="skip ahead"
          onClick={skipAhead}
        >
          <span className="guardian-skip-hint" aria-hidden="true">
            tap to continue
          </span>
        </button>
      )}
    </div>
  );
}
