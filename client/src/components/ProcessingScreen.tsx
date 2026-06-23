import { useState, useEffect } from "react";
import { ChildPortrait } from "./ChildPortrait";

const FRAGMENTS_BY_AGE: { maxAge: number; lines: string[] }[] = [
  {
    maxAge: 5,
    lines: [
      "they learned a new word",
      "they fell down and got back up",
      "they asked what a cloud is",
      "they cried for no reason",
      "they laughed at something small",
      "they needed a hug",
      "they made something and showed you",
      "they weren't scared of the dark tonight",
      "they said a word wrong in a way you'll never forget",
      "they discovered their shadow",
      "they asked if you would always be there",
      "they ate something off the floor",
      "they named a stuffed animal very seriously",
      "they had a nightmare and forgot it by morning",
      "they learned what no means",
      "they tried to put their shoes on the wrong feet",
      "they asked where they came from",
      "they hid something they broke",
      "they called someone else mama",
      "they made up a song about nothing",
      "they wouldn't let go of your hand",
      "they saw an animal die for the first time",
      "they asked if you were going to die",
      "they fell asleep mid-sentence",
      "they learned that other kids have different rules",
      "they ran just to feel fast",
      "they decided bugs were interesting",
      "they cried when you left the room",
      "they put something in the toilet that shouldn't go there",
      "they refused to eat anything that touched anything else on the plate",
      "they screamed for twenty minutes and then fell asleep immediately",
      "they told a stranger something embarrassing about you",
      "they learned the word 'why' and used it as a weapon",
      "they ate sand, on purpose, after being told not to",
      "they cried because their banana broke",
      "they called your friend by the wrong name, very confidently, for months",
      "they got scared of something completely harmless and totally irrational",
    ],
  },
  {
    maxAge: 10,
    lines: [
      "they made a new friend",
      "they lost something important",
      "they told a small lie",
      "they stayed up too late",
      "they had a hard day at school",
      "they asked a question you didn't know how to answer",
      "they figured something out on their own",
      "they decided they didn't like something anymore",
      "they got picked last",
      "they picked someone last",
      "they saw something on a screen they weren't supposed to",
      "they won something and felt strange about it",
      "they lost something and cried harder than you expected",
      "they got a best friend",
      "they lost a best friend",
      "they learned that some adults lie",
      "they had a phase you won't fully understand",
      "they read under the covers with a flashlight",
      "they kept a secret from you for the first time",
      "they wanted to be someone else for a while",
      "they felt left out and didn't say so",
      "they started caring what they looked like",
      "they got in trouble at school",
      "they stood up for someone smaller",
      "they tried to stay awake on a holiday and failed",
      "they asked what money is for",
      "they understood a joke that wasn't meant for them",
      "they learned what a real apology feels like",
      "they saw you cry and didn't know what to do",
      "they got brave about something small",
      "they told everyone at school something you said at home",
      "they lied badly and knew that you knew",
      "they got very into a hobby for exactly three weeks",
      "they convinced themselves they had a superpower",
      "they ate an entire box of something they weren't supposed to",
      "they cried over something so small you had to hide your smile",
      "they negotiated bedtime like a tiny lawyer",
      "they asked for a dog again, with new arguments",
    ],
  },
  {
    maxAge: 14,
    lines: [
      "they kept something from you",
      "they had a fight with a friend",
      "they started listening to new music",
      "they asked you not to embarrass them",
      "they cried and wouldn't say why",
      "they changed their mind about who they wanted to be",
      "they thought about what you said",
      "they started closing their door",
      "they said something cruel and felt terrible about it",
      "they wanted to be older than they were",
      "they discovered something that made them feel less alone",
      "they became someone's best friend",
      "they had a first crush they'd never admit to",
      "they started noticing how their body was different",
      "they said something funny that surprised you",
      "they stopped finding certain things funny",
      "they started to see you clearly, which hurt",
      "they spent a long time alone in their room",
      "they learned what unfairness really feels like",
      "they started worrying about the future",
      "they said they were fine when they weren't",
      "they became briefly obsessed with something you'll always remember",
      "they asked an impossible question and meant it",
      "they noticed something in the mirror they didn't like",
      "they apologized without being asked",
      "they read something that changed how they saw the world",
      "they texted a friend something they'd never say out loud",
      "they got hurt by someone they trusted",
      "they tried to hide how much they still needed you",
      "they stayed up thinking about the future",
      "they were briefly unbearable at dinner and didn't notice",
      "they discovered sarcasm and deployed it incorrectly",
      "they thought you were embarrassing without you doing anything",
      "they got very online about something for a while",
      "they explained something to you wrong, very confidently",
      "they had an enemy at school who was also their best friend",
      "they quit something you paid a lot of money for",
      "they asked you to knock before coming in",
    ],
  },
  {
    maxAge: 18,
    lines: [
      "their voice changed",
      "they fell for someone",
      "they started pulling away",
      "they came home late",
      "they had a heartbreak",
      "they disagreed with everything you said",
      "they needed space",
      "they were proud of something they didn't tell you about",
      "they stayed out past curfew and had a reason",
      "they drove alone for the first time",
      "they made a decision you wouldn't have made",
      "they had a secret life that wasn't about you",
      "they got their heart broken and didn't come to you",
      "they went somewhere without telling you",
      "they started questioning things you told them",
      "they made a friend you've never met",
      "they sat with a feeling instead of naming it",
      "they felt invisible in a crowd",
      "they made a mistake they won't talk about yet",
      "they stayed up all night for reasons you don't know",
      "they held a job and quit it",
      "they started thinking about who they want to be",
      "they felt the future pressing in",
      "they wondered if they were enough",
      "they needed to hear something you didn't think to say",
      "they had a first time they'll always remember",
      "they let someone in they shouldn't have",
      "they were cruel and immediately regretted it",
      "they made a promise they weren't sure they could keep",
      "they looked at you differently and you noticed",
      "they were caught in a lie so elaborate you almost respected it",
      "they tried to negotiate everything",
      "they ate everything in the house at midnight",
      "they slept until 2pm and felt this was reasonable",
      "they gave you a one-word answer for three months straight",
      "they were somehow both embarrassed by you and desperate for your approval",
      "they rolled their eyes so hard you're surprised they could see",
      "they discovered that you were human, which annoyed them",
    ],
  },
  {
    maxAge: Infinity,
    lines: [
      "they called less often",
      "they figured something out on their own",
      "they made a mistake and fixed it themselves",
      "they thought about what you taught them",
      "they stopped asking for your advice",
      "they understood something they couldn't have before",
      "they became someone",
      "they remembered",
      "they learned to be alone and were okay",
      "they paid a bill and felt strange about it",
      "they had a relationship that mattered",
      "they called to say nothing in particular",
      "they did something you always said they should do",
      "they did something you always said not to",
      "they visited a place from their childhood and felt it differently",
      "they thought of you at a random moment",
      "they had to take care of something hard by themselves",
      "they made a home",
      "they told a story about their childhood you'd never heard",
      "they forgave something without saying so",
      "they understood why you were the way you were",
      "they missed you and didn't call",
      "they started becoming a little bit like you",
      "they worked through something in therapy you never knew about",
      "they held someone while they cried",
      "they hit a wall and kept going",
      "they chose something brave and quiet",
      "they said your name to a stranger with pride",
      "they sat with grief without asking anyone to fix it",
      "they grew into something you couldn't have predicted",
      "they called to ask how to boil an egg",
      "they finally admitted you were right about something",
      "they discovered they had your sense of humor and weren't sure how to feel",
      "they called because they missed you but talked about something else",
      "they texted 'are you awake' at an unreasonable hour",
      "they told a friend something you said, as wisdom, not knowing you were guessing",
      "they started giving other people the advice you gave them",
      "they accidentally became responsible",
    ],
  },
];

function fragmentsForAge(age: number): string[] {
  return (
    FRAGMENTS_BY_AGE.find((b) => age <= b.maxAge)?.lines ??
    FRAGMENTS_BY_AGE[FRAGMENTS_BY_AGE.length - 1].lines
  );
}

interface Props {
  childName: string;
  age?: number;
  gameId?: string | null;
}

export function ProcessingScreen({ childName, age = 6, gameId }: Props) {
  const fragments = fragmentsForAge(age);
  const [fragmentIdx, setFragmentIdx] = useState(0);

  useEffect(() => {
    setFragmentIdx(0);
    const id = setInterval(() => {
      setFragmentIdx((i) => (i + 1) % fragments.length);
    }, 2400);
    return () => clearInterval(id);
  }, [age, fragments.length]);

  return (
    <div className="processing-screen">
      <div className="processing-figure">
        <ChildPortrait age={age} size={140} gameId={gameId} />
      </div>
      <p className="processing-name">{childName}</p>
      <div className="processing-fragment-area">
        <span key={fragmentIdx} className="processing-fragment-text">
          {fragments[fragmentIdx]}
        </span>
      </div>
    </div>
  );
}
