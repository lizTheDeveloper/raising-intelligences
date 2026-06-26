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

// ---------- Step sequence ----------
// Narrative lines auto-advance on a timer; quiz/confessional/reveal steps
// advance only on user action.

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
}

function pickVariant(): number {
  return Math.floor(Math.random() * INTRO_VARIANTS);
}

// ---------- Component ----------
export function GuardianScreen({ childName, gameId, eventReady, onReady, onSubmitPersonality, seedReadyProp }: Props) {
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

  // Fragment list — accumulates up to 10, fade-in + append style
  const [visibleFragments, setVisibleFragments] = useState<string[]>([]);
  const fragmentPoolUsed = useRef(new Set<number>());

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
      if (STEPS[i].age !== undefined) return STEPS[i].age!;
    }
    return 0;
  }, [stepIndex]);

  const portraitRevealed = currentStep.kind === "reveal" ||
    currentStep.kind === "confessional" ||
    currentStep.kind === "waiting";

  // ---------- Auto-advance narrative, transition, and reveal steps ----------
  useEffect(() => {
    if (
      currentStep.kind !== "narrative" &&
      currentStep.kind !== "transition" &&
      currentStep.kind !== "reveal"
    ) return;

    // Reveal step: just pause to let the portrait land, then advance
    if (currentStep.kind === "reveal") {
      const timer = setTimeout(() => setStepIndex((i) => i + 1), 2500);
      return () => clearTimeout(timer);
    }

    // Add the line to the narrative display
    if (currentStep.text) {
      setNarrativeLines((prev) => {
        if (prev[prev.length - 1] === currentStep.text) return prev;
        return [...prev, currentStep.text!];
      });
    }

    // Auto-advance after a delay
    const isFirst = stepIndex === 0;
    const isNewAge = stepIndex > 0 && currentStep.age !== undefined &&
      STEPS[stepIndex - 1]?.age !== currentStep.age;
    const delay = isFirst ? 1200 : isNewAge ? 2400 : 1600;

    const timer = setTimeout(() => setStepIndex((i) => i + 1), delay);
    return () => clearTimeout(timer);
  }, [stepIndex, currentStep]);

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
      onSubmitPersonality({ ocean: oceanAnswers, confessional1, confessional2 });
      setSeedSubmitting(false);
      track("personality_submitted", { mode: "multiplayer" });
      setStepIndex((i) => i + 1);
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
      }
    } catch (err) {
      personalitySubmitted.current = false;
      setSeedError(err instanceof Error ? err.message : String(err));
      track("personality_error");
    } finally {
      setSeedSubmitting(false);
    }

    // Advance to waiting step
    setStepIndex((i) => i + 1);
  }, [gameId, oceanAnswers, confessional1, confessional2, base, onSubmitPersonality]);

  // ---------- Retry personality on error ----------
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
  // Don't gate on eventReady: event loading can take 30–90s (LLM). EventIntro
  // already shows a spinner while loadingEvent is true, so the user can proceed
  // from the guardian screen as soon as their personality is submitted.
  const canBegin = effectiveSeedReady && portraitRevealed;

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
                className={`guardian-quiz-option${
                  oceanAnswers[currentStep.quizIndex!] === opt.value
                    ? " guardian-quiz-selected"
                    : ""
                }`}
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
          <div className="guardian-thoughts">
            {visibleFragments.map((text, i) => (
              <span key={`${text}-${i}`} className="guardian-thought">
                {text}
              </span>
            ))}
          </div>
        )}

      {/* Waiting state — seed generation and/or event loading */}
      {currentStep.kind === "waiting" && (
        <>
          {seedError && (
            <div className="guardian-seed-error">
              <p className="dim">something went wrong generating their personality.</p>
              <button className="btn dim" onClick={handleRetry}>
                try again
              </button>
            </div>
          )}

          {seedSubmitting && (
            <p className="guardian-loading-hint">shaping who they'll become...</p>
          )}

          {canBegin && (
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
              {!showMessage && (
                <button
                  className="btn dim"
                  data-testid="btn-guardian-not-ready"
                  onClick={handleNotReady}
                >
                  I'm not ready
                </button>
              )}
            </div>
          )}

          {!canBegin && !seedError && !seedSubmitting && (
            <p className="guardian-loading-hint">take your time. we're getting your story ready.</p>
          )}

          {showMessage && (
            <div className="guardian-not-ready-block">
              <p className="guardian-not-ready-message">most people aren't</p>
              {(!eventReady || !seedReady) && (
                <p className="guardian-loading-hint">
                  take your time. we're getting your story ready.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
