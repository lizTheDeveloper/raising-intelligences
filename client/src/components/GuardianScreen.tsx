import { useState, useEffect } from "react";
import { ChildPortrait } from "./ChildPortrait";
import { track } from "../analytics";

const FRAGMENTS = [
  "they took their first steps.",
  "they said your name.",
  "they asked why things are the way they are.",
  "they laughed at something small.",
  "they fell asleep in the car on the way home.",
  "they scraped their knee and looked to you first.",
  "they reached for your hand.",
  "they're already becoming someone.",
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
  "it's raining inside.",
  "i made it rain.",
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
  "i'm tired but i won't sleep.",
  "my feet hurt.",
  "i want to be carried.",
  "pick me up.",
  "i'm too big for that.",
  "but i want to anyway.",
  "i changed my mind.",
  "i don't know.",
  "yes and no.",
  "maybe tomorrow.",
  "i'll think about it.",
  "i need to decide.",
  "this or that?",
  "i pick both.",
  "can we have pizza?",
  "i want pancakes.",
  "i hate vegetables.",
  "i love ice cream.",
  "i want dessert first.",
  "can i have water?",
  "not that straw.",
  "the cup is dirty.",
  "i need a new spoon.",
  "this chair is mine.",
  "i saw a truck.",
  "i saw a bus.",
  "i saw a train.",
  "they go fast.",
  "i want to drive.",
  "beep beep.",
  "i'm the conductor.",
  "all aboard.",
  "next stop.",
  "i'm coming through.",
  "excuse me.",
  "i'm right here.",
  "i'm still little.",
  "but i'm big too.",
  "sometimes.",
  "when i want to be.",
  "i'm brave today.",
  "i'm not scared.",
  "okay maybe a little.",
  "but not of that.",
  "i can handle it.",
  "i'm strong enough.",
  "i'm smart enough.",
  "i know that word.",
  "it means...",
  "i forgot what it means.",
  "i'll learn it again.",
  "i'm practicing.",
  "i'm getting better.",
  "watch me.",
  "i'm showing you.",
  "this is important.",
  "listen to me.",
  "i have something to say.",
  "are you listening?",
  "this is serious.",
  "i'm not joking.",
  "i promise.",
  "cross my heart.",
  "i meant it.",
  "i was telling the truth.",
  "i can count to ten.",
  "one, two...",
  "i lost my place.",
  "start over?",
  "i'm counting again.",
  "numbers are hard.",
  "letters too.",
  "but i'm learning.",
  "my teacher said so.",
  "she's nice.",
  "she helps me.",
  "i like school.",
  "i don't like school.",
  "sometimes i like it.",
  "it depends.",
  "on if it's raining.",
  "i don't like rain.",
  "i like sun.",
  "i like snow too.",
  "it's cold but fun.",
  "i made a snowball.",
  "i made a snowman.",
  "where did he go?",
  "he melted.",
  "that's okay.",
  "he wanted to go anyway.",
  "everything goes somewhere.",
  "i know that now.",
  "i'm older.",
  "i turned three.",
  "that's a big number.",
  "three is my favorite.",
  "not two anymore.",
  "two was too small.",
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

export function GuardianScreen({ childName, gameId, eventReady, onReady }: Props) {
  const [fragmentIdx, setFragmentIdx] = useState(0);
  const [thoughtIdx, setThoughtIdx] = useState(0);
  const [portraitReady, setPortraitReady] = useState(false);
  const [showMessage, setShowMessage] = useState(false);

  useEffect(() => {
    if (portraitReady) return;
    const id = setInterval(() => {
      setFragmentIdx((i) => (i + 1) % FRAGMENTS.length);
    }, 2600);
    return () => clearInterval(id);
  }, [portraitReady]);

  useEffect(() => {
    if (eventReady) return;
    const id = setInterval(() => {
      setThoughtIdx((i) => (i + 1) % CHILD_THOUGHTS.length);
    }, 7000);
    return () => clearInterval(id);
  }, [eventReady]);

  const handleNotReady = () => {
    setShowMessage(true);
    // Brief delay to show the message before transitioning
    setTimeout(() => {
      track("guardian_not_ready");
      onReady();
    }, 1500);
  };

  const canBegin = eventReady && !showMessage;

  return (
    <div className="guardian-screen">
      <h2 className="guardian-name">{childName}</h2>

      <div className="guardian-figure">
        {/* Portrait fades in once ready; fragments show until then */}
        <div className={`guardian-portrait-wrap${portraitReady ? " guardian-portrait-revealed" : ""}`}>
          <ChildPortrait age={3} size={200} gameId={gameId} onLoad={() => setPortraitReady(true)} />
        </div>

        {!portraitReady && (
          <div className="guardian-fragments">
            <span key={fragmentIdx} className="guardian-fragment">
              {FRAGMENTS[fragmentIdx]}
            </span>
          </div>
        )}
      </div>

      {portraitReady && !eventReady && (
        <>
          <div className="guardian-revealed-text">
            <p>three years old.</p>
            <p>they need you.</p>
          </div>
          <div className="guardian-thoughts">
            <span key={thoughtIdx} className="guardian-thought">
              {CHILD_THOUGHTS[thoughtIdx]}
            </span>
          </div>
        </>
      )}

      {eventReady && (
        <div className="guardian-buttons">
          <button
            className="btn"
            onClick={() => { track("guardian_accepted"); onReady(); }}
          >
            I'm ready
          </button>
          <button
            className="btn dim"
            onClick={handleNotReady}
          >
            I'm not ready
          </button>
        </div>
      )}

      {showMessage && (
        <p className="guardian-not-ready-message">most people aren't</p>
      )}
    </div>
  );
}
