/**
 * Child thought fragments for the Guardian Screen cycling bubble.
 *
 * Each fragment is optionally tagged with 0-2 OCEAN trait directions.
 * Trait indices: 0=Openness, 1=Conscientiousness, 2=Extraversion,
 * 3=Agreeableness, 4=Neuroticism.
 *
 * Scores 1-4: high = 3-4, low = 1-2.
 */

export type TraitDirection = { trait: number; direction: "high" | "low" };

export interface TaggedFragment {
  text: string;
  tags: TraitDirection[];
}

const fragments: TaggedFragment[] = [
  // --- Openness high ---
  { text: "why is the sky so big?", tags: [{ trait: 0, direction: "high" }] },
  { text: "where did the moon go?", tags: [{ trait: 0, direction: "high" }] },
  { text: "what's that sound?", tags: [{ trait: 0, direction: "high" }] },
  { text: "where does the water go?", tags: [{ trait: 0, direction: "high" }] },
  { text: "why are leaves green?", tags: [{ trait: 0, direction: "high" }] },
  { text: "who made the stars?", tags: [{ trait: 0, direction: "high" }] },
  { text: "what happens if i press this?", tags: [{ trait: 0, direction: "high" }] },
  { text: "i have an idea.", tags: [{ trait: 0, direction: "high" }] },
  { text: "i want to go somewhere new.", tags: [{ trait: 0, direction: "high" }] },
  { text: "i learned something new.", tags: [{ trait: 0, direction: "high" }] },

  // --- Openness low ---
  { text: "i want to go home.", tags: [{ trait: 0, direction: "low" }] },
  { text: "i don't like this.", tags: [{ trait: 0, direction: "low" }] },
  { text: "can we go back?", tags: [{ trait: 0, direction: "low" }] },
  { text: "i want to stay here forever.", tags: [{ trait: 0, direction: "low" }] },

  // --- Conscientiousness high ---
  { text: "i tried my best.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'll try again.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'm almost done.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'm getting better.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'm practicing.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'll be more careful.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i built a tower.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i did it by myself.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'm proud of this.", tags: [{ trait: 1, direction: "high" }] },

  // --- Conscientiousness low ---
  { text: "i forgot what i wanted.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i lost my sock.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i forgot the word.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i lost my place.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i changed my mind.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i don't remember.", tags: [{ trait: 1, direction: "low" }] },

  // --- Extraversion high ---
  { text: "i made a friend today.", tags: [{ trait: 2, direction: "high" }] },
  { text: "can we go to the park?", tags: [{ trait: 2, direction: "high" }] },
  { text: "look at my drawing!", tags: [{ trait: 2, direction: "high" }] },
  { text: "watch me jump.", tags: [{ trait: 2, direction: "high" }] },
  { text: "watch me run.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i'm a superhero.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i'm a dinosaur.", tags: [{ trait: 2, direction: "high" }] },
  { text: "you can't catch me.", tags: [{ trait: 2, direction: "high" }] },
  { text: "look what i made.", tags: [{ trait: 2, direction: "high" }] },
  { text: "we can play together.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i want to show you something.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i'm coming!", tags: [{ trait: 2, direction: "high" }] },

  // --- Extraversion low ---
  { text: "it's too loud.", tags: [{ trait: 2, direction: "low" }] },
  { text: "i'm hiding.", tags: [{ trait: 2, direction: "low" }] },
  { text: "i'm still here.", tags: [{ trait: 2, direction: "low" }] },
  { text: "i'm waiting.", tags: [{ trait: 2, direction: "low" }] },
  { text: "this is mine.", tags: [{ trait: 2, direction: "low" }] },

  // --- Agreeableness high ---
  { text: "i'm sorry.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i love you more.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i love you most.", tags: [{ trait: 3, direction: "high" }] },
  { text: "can i help?", tags: [{ trait: 3, direction: "high" }] },
  { text: "i like sharing.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i'm being good.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i promise.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i need help.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i drew a picture of us.", tags: [{ trait: 3, direction: "high" }] },

  // --- Agreeableness low ---
  { text: "it's not fair.", tags: [{ trait: 3, direction: "low" }] },
  { text: "i'm the boss.", tags: [{ trait: 3, direction: "low" }] },
  { text: "i can do it myself.", tags: [{ trait: 3, direction: "low" }] },
  { text: "not that straw.", tags: [{ trait: 3, direction: "low" }] },
  { text: "i don't want to.", tags: [{ trait: 3, direction: "low" }] },

  // --- Neuroticism high ---
  { text: "i'm scared of the dark.", tags: [{ trait: 4, direction: "high" }] },
  { text: "why does it hurt?", tags: [{ trait: 4, direction: "high" }] },
  { text: "i made a mistake.", tags: [{ trait: 4, direction: "high" }] },
  { text: "don't leave.", tags: [{ trait: 4, direction: "high" }] },
  { text: "are you there?", tags: [{ trait: 4, direction: "high" }] },
  { text: "where are you going?", tags: [{ trait: 4, direction: "high" }] },
  { text: "why do you have to leave?", tags: [{ trait: 4, direction: "high" }] },
  { text: "okay maybe a little.", tags: [{ trait: 4, direction: "high" }] },
  { text: "i miss my blanket.", tags: [{ trait: 4, direction: "high" }] },

  // --- Neuroticism low ---
  { text: "i'm not scared.", tags: [{ trait: 4, direction: "low" }] },
  { text: "i can handle it.", tags: [{ trait: 4, direction: "low" }] },
  { text: "i'm strong enough.", tags: [{ trait: 4, direction: "low" }] },
  { text: "i'm brave today.", tags: [{ trait: 4, direction: "low" }] },
  { text: "that's okay.", tags: [{ trait: 4, direction: "low" }] },

  // --- Neutral (no trait tags) ---
  { text: "can i have juice?", tags: [] },
  { text: "i'm not tired.", tags: [] },
  { text: "i don't like carrots but i like cake.", tags: [] },
  { text: "is that a bug or a dot?", tags: [] },
  { text: "i want to stay up later.", tags: [] },
  { text: "i found a rock.", tags: [] },
  { text: "why can't i eat the crayons?", tags: [] },
  { text: "i'm hungry again.", tags: [] },
  { text: "the sky is crying.", tags: [] },
  { text: "why do dogs bark?", tags: [] },
  { text: "that's too heavy.", tags: [] },
  { text: "the sun went to sleep.", tags: [] },
  { text: "can i touch that?", tags: [] },
  { text: "i found a stick.", tags: [] },
  { text: "this is too hot.", tags: [] },
  { text: "the water is cold.", tags: [] },
  { text: "i want to fly.", tags: [] },
  { text: "where's my other shoe?", tags: [] },
  { text: "i'm bored.", tags: [] },
  { text: "look at the airplane!", tags: [] },
  { text: "the floor is lava.", tags: [] },
  { text: "i want that toy.", tags: [] },
  { text: "can we get a cat?", tags: [] },
  { text: "i don't understand.", tags: [] },
  { text: "that tickles.", tags: [] },
  { text: "the ice cream melted.", tags: [] },
  { text: "why is the grass so tall?", tags: [] },
  { text: "i like this song.", tags: [] },
  { text: "i found a penny.", tags: [] },
  { text: "i want to go faster.", tags: [] },
  { text: "that's my favorite.", tags: [] },
  { text: "it's too far away.", tags: [] },
  { text: "i think it's broken.", tags: [] },
  { text: "why can't i reach it?", tags: [] },
  { text: "i'm thirsty.", tags: [] },
  { text: "that smells funny.", tags: [] },
  { text: "i want to see it again.", tags: [] },
  { text: "it's all gone.", tags: [] },
  { text: "i found a hole.", tags: [] },
  { text: "i'm ready now.", tags: [] },
  { text: "the cat is sleeping.", tags: [] },
  { text: "i have a secret.", tags: [] },
  { text: "i wish i could.", tags: [] },
  { text: "i think i know.", tags: [] },
  { text: "that's not how it works.", tags: [] },
  { text: "i like the way it feels.", tags: [] },
  { text: "i want to try again.", tags: [] },
  { text: "i'm not done yet.", tags: [] },
  { text: "can i have more?", tags: [] },
  { text: "i'm fast.", tags: [] },
  { text: "i'm strong.", tags: [] },
  { text: "i can do anything.", tags: [] },
  { text: "the dog is my friend.", tags: [] },
  { text: "i saw something cool.", tags: [] },
  { text: "i don't want to go to bed.", tags: [] },
  { text: "can you read to me?", tags: [] },
  { text: "one more story?", tags: [] },
  { text: "the stars are blinking.", tags: [] },
  { text: "i think the moon follows us.", tags: [] },
  { text: "i want to be big.", tags: [] },
  { text: "when i grow up.", tags: [] },
  { text: "i love my shoes.", tags: [] },
  { text: "i don't like this shirt.", tags: [] },
  { text: "i want to wear the red one.", tags: [] },
  { text: "find me if you can.", tags: [] },
  { text: "i'm right here.", tags: [] },
  { text: "i can hear you.", tags: [] },
  { text: "i saw a bird.", tags: [] },
  { text: "it was blue.", tags: [] },
  { text: "i know a lot of things.", tags: [] },
  { text: "i'm teaching you.", tags: [] },
  { text: "i'm smart enough.", tags: [] },
  { text: "i know that word.", tags: [] },
  { text: "i forgot what it means.", tags: [] },
  { text: "i'll learn it again.", tags: [] },
  { text: "this is important.", tags: [] },
  { text: "listen to me.", tags: [] },
  { text: "i have something to say.", tags: [] },
  { text: "are you listening?", tags: [] },
  { text: "cross my heart.", tags: [] },
  { text: "i can count to ten.", tags: [] },
  { text: "one, two...", tags: [] },
  { text: "start over?", tags: [] },
  { text: "numbers are hard.", tags: [] },
  { text: "letters too.", tags: [] },
  { text: "but i'm learning.", tags: [] },
  { text: "i like school.", tags: [] },
  { text: "i don't like school.", tags: [] },
  { text: "sometimes i like it.", tags: [] },
  { text: "it depends.", tags: [] },
  { text: "i made a snowball.", tags: [] },
  { text: "where did he go?", tags: [] },
  { text: "he melted.", tags: [] },
  { text: "everything goes somewhere.", tags: [] },
  { text: "i know that now.", tags: [] },
  { text: "i'm older.", tags: [] },
  { text: "i turned three.", tags: [] },
  { text: "that's a big number.", tags: [] },
  { text: "i'm bigger now.", tags: [] },
  { text: "i'm learning how to use the toilet.", tags: [] },
  { text: "sometimes i forget.", tags: [] },
  { text: "but i'm getting there.", tags: [] },
  { text: "flush!", tags: [] },
  { text: "did you hear?", tags: [] },
  { text: "almost a big kid.", tags: [] },
  { text: "not yet though.", tags: [] },
  { text: "soon.", tags: [] },
  { text: "i heard my name.", tags: [] },
  { text: "stay here.", tags: [] },
  { text: "i'm still little.", tags: [] },
  { text: "but i'm big too.", tags: [] },
  { text: "sometimes.", tags: [] },
  { text: "when i want to be.", tags: [] },
  { text: "excuse me.", tags: [] },
  { text: "i'm coming through.", tags: [] },
  { text: "beep beep.", tags: [] },
  { text: "all aboard.", tags: [] },
  { text: "they go fast.", tags: [] },
  { text: "i saw a truck.", tags: [] },
  { text: "i saw a train.", tags: [] },
  { text: "this chair is mine.", tags: [] },
  { text: "i need a new spoon.", tags: [] },
  { text: "i want dessert first.", tags: [] },
  { text: "i love ice cream.", tags: [] },
  { text: "i want pancakes.", tags: [] },
  { text: "can we have pizza?", tags: [] },
  { text: "i pick both.", tags: [] },
  { text: "this or that?", tags: [] },
  { text: "i'll think about it.", tags: [] },
  { text: "maybe tomorrow.", tags: [] },
  { text: "i don't know.", tags: [] },
  { text: "pick me up.", tags: [] },
  { text: "i want to be carried.", tags: [] },
  { text: "my feet hurt.", tags: [] },
  { text: "i want to go home now.", tags: [] },
];

/**
 * Return a weighted copy of the fragment pool based on OCEAN answers so far.
 *
 * The ocean array can be partial (length 0-5). Each entry is 1-4.
 * For each answered trait, matching-direction fragments get extra weight.
 *
 * The returned array may contain duplicates to bias random selection.
 * Callers pick randomly from the result.
 */
export function getWeightedFragments(ocean: number[]): TaggedFragment[] {
  if (ocean.length === 0) return fragments;

  // Build direction map for answered traits
  const directions = new Map<number, "high" | "low">();
  for (let i = 0; i < ocean.length; i++) {
    directions.set(i, ocean[i] >= 3 ? "high" : "low");
  }

  const result: TaggedFragment[] = [];
  for (const f of fragments) {
    let weight = 1;
    if (f.tags.length > 0) {
      let matches = 0;
      let mismatches = 0;
      for (const tag of f.tags) {
        const dir = directions.get(tag.trait);
        if (dir === undefined) continue; // trait not answered yet
        if (dir === tag.direction) matches++;
        else mismatches++;
      }
      // Boost matching, suppress mismatching
      if (matches > 0 && mismatches === 0) weight = 3;
      else if (mismatches > 0 && matches === 0) weight = 0; // exclude mismatches
      // mixed: weight stays 1
    }
    for (let i = 0; i < weight; i++) {
      result.push(f);
    }
  }

  return result;
}
