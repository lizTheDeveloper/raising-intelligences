import { useState, useEffect, useMemo } from "react";
import { ChildPortrait } from "./ChildPortrait";
import { track } from "../analytics";

const INTRO_VARIANTS = 6;

interface IntroStage {
  age: number;
  lines: string[];
}

const INTRO_STAGES: IntroStage[] = [
  {
    age: 0,
    lines: [
      "born on a quiet night.",
      "so small you were afraid to breathe.",
    ],
  },
  {
    age: 1,
    lines: [
      "they reached for everything.",
      "they said something that almost sounded like your name.",
    ],
  },
  {
    age: 2,
    lines: [
      "they took their first steps.",
      "they fell. they got back up.",
    ],
  },
];

const CHILD_THOUGHTS = [
  "why is the sky so big?",
  "can i have juice?",
  "where did the moon go?",
  "i'm not tired.",
  "what's that sound?",
  "i made a friend today.",
  "i don't like carrots but i like cake.",
  "why do you have to leave?",
  "is that a bug or a dot?",
  "i want to stay up later.",
  "can we go to the park?",
  "i found a rock.",
  "why can't i eat the crayons?",
  "look at my drawing!",
  "i'm hungry again.",
  "where does the water go?",
  "it's too loud.",
  "i love you more.",
  "i don't want to nap.",
  "what's my name again?",
  "why is that man so tall?",
  "i lost my sock.",
  "the sky is crying.",
  "i want to go home.",
  "why do dogs bark?",
  "i can do it myself.",
  "that's too heavy.",
  "i forgot what i wanted.",
  "the sun went to sleep.",
  "can i touch that?",
  "i have an idea.",
  "why are leaves green?",
  "i found a stick.",
  "this is too hot.",
  "the water is cold.",
  "i want to fly.",
  "where's my other shoe?",
  "i'm bored.",
  "look at the airplane!",
  "i don't like this.",
  "the floor is lava.",
  "i want that toy.",
  "why does it hurt?",
  "i made a mistake.",
  "it's not fair.",
  "i'll be more careful.",
  "can we get a cat?",
  "i'm scared of the dark.",
  "who made the stars?",
  "i don't understand.",
  "that tickles.",
  "i want to show you something.",
  "the ice cream melted.",
  "i miss my blanket.",
  "why is the grass so tall?",
  "i like this song.",
  "i'm almost done.",
  "i'm coming!",
  "i found a penny.",
  "can i help?",
  "i want to go faster.",
  "that's my favorite.",
  "i don't remember.",
  "it's too far away.",
  "i think it's broken.",
  "i'm sorry.",
  "i love you most.",
  "why can't i reach it?",
  "i built a tower.",
  "can we go back?",
  "i'm thirsty.",
  "that smells funny.",
  "i want to see it again.",
  "it's all gone.",
  "i found a hole.",
  "i don't want to.",
  "i'm ready now.",
  "the cat is sleeping.",
  "i have a secret.",
  "i wish i could.",
  "i think i know.",
  "that's not how it works.",
  "i like the way it feels.",
  "i want to try again.",
  "i'm not done yet.",
  "can i have more?",
  "i'm a superhero.",
  "i'm a dinosaur.",
  "watch me jump.",
  "watch me run.",
  "i'm fast.",
  "i'm strong.",
  "i can do anything.",
  "i forgot the word.",
  "the dog is my friend.",
  "i drew a picture of us.",
  "i want to stay here forever.",
  "i want to go somewhere new.",
  "what happens if i press this?",
  "i heard my name.",
  "i saw something cool.",
  "i don't want to go to bed.",
  "can you read to me?",
  "one more story?",
  "the stars are blinking.",
  "i think the moon follows us.",
  "i want to be big.",
  "when i grow up.",
  "i love my shoes.",
  "i don't like this shirt.",
  "i want to wear the red one.",
  "i'm the boss.",
  "you can't catch me.",
  "i'm hiding.",
  "find me if you can.",
  "i'm still here.",
  "i'm waiting.",
  "where are you going?",
  "don't leave.",
  "stay here.",
  "i'm right here.",
  "are you there?",
  "i can hear you.",
  "i saw a bird.",
  "it was blue.",
  "i know a lot of things.",
  "i learned something new.",
  "i'm teaching you.",
  "this is mine.",
  "i like sharing.",
  "we can play together.",
  "i'm being good.",
  "i tried my best.",
  "it didn't work.",
  "i'll try again.",
  "i'm almost there.",
  "just a little more.",
  "i need help.",
  "i did it by myself.",
  "look what i made.",
  "i'm proud of this.",
  "i want to go home now.",
  "my feet hurt.",
  "i want to be carried.",
  "pick me up.",
  "i changed my mind.",
  "i don't know.",
  "maybe tomorrow.",
  "i'll think about it.",
  "this or that?",
  "i pick both.",
  "can we have pizza?",
  "i want pancakes.",
  "i love ice cream.",
  "i want dessert first.",
  "not that straw.",
  "i need a new spoon.",
  "this chair is mine.",
  "i saw a truck.",
  "i saw a train.",
  "they go fast.",
  "beep beep.",
  "all aboard.",
  "i'm coming through.",
  "excuse me.",
  "i'm still little.",
  "but i'm big too.",
  "sometimes.",
  "when i want to be.",
  "i'm brave today.",
  "i'm not scared.",
  "okay maybe a little.",
  "i can handle it.",
  "i'm strong enough.",
  "i'm smart enough.",
  "i know that word.",
  "i forgot what it means.",
  "i'll learn it again.",
  "i'm practicing.",
  "i'm getting better.",
  "watch me.",
  "this is important.",
  "listen to me.",
  "i have something to say.",
  "are you listening?",
  "i promise.",
  "cross my heart.",
  "i can count to ten.",
  "one, two...",
  "i lost my place.",
  "start over?",
  "numbers are hard.",
  "letters too.",
  "but i'm learning.",
  "i like school.",
  "i don't like school.",
  "sometimes i like it.",
  "it depends.",
  "i made a snowball.",
  "where did he go?",
  "he melted.",
  "that's okay.",
  "everything goes somewhere.",
  "i know that now.",
  "i'm older.",
  "i turned three.",
  "that's a big number.",
  "i'm bigger now.",
  "i'm learning how to use the toilet.",
  "sometimes i forget.",
  "but i'm getting there.",
  "flush!",
  "did you hear?",
  "i'm almost done.",
  "almost a big kid.",
  "not yet though.",
  "soon.",
];

interface Props {
  childName: string;
  gameId: string | null;
  eventReady: boolean;
  onReady: () => void;
}

function pickVariant(): number {
  return Math.floor(Math.random() * INTRO_VARIANTS);
}

export function GuardianScreen({ childName, gameId, eventReady, onReady }: Props) {
  const [lineCount, setLineCount] = useState(0);
  const [portraitReady, setPortraitReady] = useState(false);
  const [showFinalText, setShowFinalText] = useState(false);
  const [thoughtIdx, setThoughtIdx] = useState(() =>
    Math.floor(Math.random() * CHILD_THOUGHTS.length)
  );
  const [showMessage, setShowMessage] = useState(false);

  const variant = useMemo(pickVariant, []);
  const base = import.meta.env.BASE_URL;

  const allIntroLines = useMemo(
    () => INTRO_STAGES.flatMap((s) => s.lines),
    []
  );
  const totalIntroLines = allIntroLines.length;
  const introComplete = lineCount >= totalIntroLines;

  // Compute current stage from lineCount
  const currentStage = useMemo(() => {
    let count = 0;
    for (let i = 0; i < INTRO_STAGES.length; i++) {
      count += INTRO_STAGES[i].lines.length;
      if (lineCount < count) return i;
    }
    return INTRO_STAGES.length - 1;
  }, [lineCount]);

  // Compute whether this lineCount is the first line of a new stage
  const isFirstLineOfStage = useMemo(() => {
    let count = 0;
    for (const stage of INTRO_STAGES) {
      if (lineCount === count) return true;
      count += stage.lines.length;
    }
    return false;
  }, [lineCount]);

  // Advance line counter on a timer
  useEffect(() => {
    if (lineCount >= totalIntroLines) return;
    const delay = lineCount === 0 ? 1200 : isFirstLineOfStage ? 2400 : 1600;
    const timer = setTimeout(() => setLineCount((c) => c + 1), delay);
    return () => clearTimeout(timer);
  }, [lineCount, totalIntroLines, isFirstLineOfStage]);

  // Show final text once intro is done and portrait is ready
  useEffect(() => {
    if (!introComplete || !portraitReady) return;
    const t = setTimeout(() => setShowFinalText(true), 800);
    return () => clearTimeout(t);
  }, [introComplete, portraitReady]);

  useEffect(() => {
    if (!showFinalText || eventReady) return;
    const id = setInterval(() => {
      setThoughtIdx((prev) => {
        const next = Math.floor(Math.random() * CHILD_THOUGHTS.length);
        if (next === prev && CHILD_THOUGHTS.length > 1) {
          return (next + 1) % CHILD_THOUGHTS.length;
        }
        return next;
      });
    }, 7000);
    return () => clearInterval(id);
  }, [showFinalText, eventReady]);

  const handleNotReady = () => {
    track("guardian_not_ready");
    setShowMessage(true);
  };

  const canBegin = eventReady && showFinalText;

  return (
    <div className="guardian-screen">
      <h2 className="guardian-name">{childName}</h2>

      <div className="guardian-figure">
        {INTRO_STAGES.map((stage, i) => (
          <div
            key={stage.age}
            className={`guardian-intro-image${
              !introComplete && currentStage === i
                ? " guardian-intro-visible"
                : ""
            }`}
          >
            <img
              src={`${base}portraits/intro/age-${stage.age}-${variant}.jpg`}
              alt=""
              aria-hidden="true"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
            />
          </div>
        ))}

        <div
          className={`guardian-portrait-wrap${
            introComplete && portraitReady ? " guardian-portrait-revealed" : ""
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

      <div className="guardian-loading-lines">
        {allIntroLines.slice(0, lineCount).map((line, i) => (
          <p key={i} className="guardian-line">
            {line}
          </p>
        ))}
        {showFinalText && (
          <>
            <p className="guardian-line">three years old.</p>
            <p className="guardian-line">they need you.</p>
          </>
        )}
      </div>

      {showFinalText && !eventReady && (
        <div className="guardian-thoughts">
          <span key={thoughtIdx} className="guardian-thought">
            {CHILD_THOUGHTS[thoughtIdx]}
          </span>
        </div>
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
            <button className="btn dim" data-testid="btn-guardian-not-ready" onClick={handleNotReady}>
              I'm not ready
            </button>
          )}
        </div>
      )}

      {showMessage && (
        <div style={{ textAlign: "center" }}>
          <p className="guardian-not-ready-message">most people aren't</p>
          <p className="guardian-not-ready-message" style={{ animationDelay: "0.5s", marginTop: "6px" }}>
            take your time. we're getting your story ready.
          </p>
        </div>
      )}
    </div>
  );
}
