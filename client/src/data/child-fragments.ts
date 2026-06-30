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
  { text: "what's that sound?", tags: [{ trait: 0, direction: "high" }] },
  { text: "what happens if i press this?", tags: [{ trait: 0, direction: "high" }] },
  { text: "i have an idea.", tags: [{ trait: 0, direction: "high" }] },
  { text: "i want to go somewhere new.", tags: [{ trait: 0, direction: "high" }] },
  { text: "i learned something new.", tags: [{ trait: 0, direction: "high" }] },
  { text: "where does the water go?", tags: [{ trait: 0, direction: "high" }] },
  { text: "do worms have dreams?", tags: [{ trait: 0, direction: "high" }] },
  { text: "i bet fish don't know they're wet.", tags: [{ trait: 0, direction: "high" }] },
  { text: "what does the color blue taste like?", tags: [{ trait: 0, direction: "high" }] },
  { text: "do my teeth know they're inside my mouth?", tags: [{ trait: 0, direction: "high" }] },
  { text: "i invented a new animal.", tags: [{ trait: 0, direction: "high" }] },
  { text: "what if gravity just stops one day?", tags: [{ trait: 0, direction: "high" }] },
  { text: "is water wet or does it make things wet?", tags: [{ trait: 0, direction: "high" }] },
  { text: "do you think the sun gets bored?", tags: [{ trait: 0, direction: "high" }] },

  // --- Openness low ---
  { text: "i want to go home.", tags: [{ trait: 0, direction: "low" }] },
  { text: "i don't like this.", tags: [{ trait: 0, direction: "low" }] },
  { text: "can we go back?", tags: [{ trait: 0, direction: "low" }] },
  { text: "i want to stay here forever.", tags: [{ trait: 0, direction: "low" }] },
  { text: "that's not how we usually do it.", tags: [{ trait: 0, direction: "low" }] },
  { text: "i want the same one as last time.", tags: [{ trait: 0, direction: "low" }] },
  { text: "this smells different.", tags: [{ trait: 0, direction: "low" }] },

  // --- Conscientiousness high ---
  { text: "i'll try again.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'm almost done.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'll be more careful.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i built a tower.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i did it by myself.", tags: [{ trait: 1, direction: "high" }] },
  { text: "that's not where that goes.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i made a list.", tags: [{ trait: 1, direction: "high" }] },
  { text: "you're doing it wrong.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i sorted them by size.", tags: [{ trait: 1, direction: "high" }] },
  { text: "it needs to be even.", tags: [{ trait: 1, direction: "high" }] },
  { text: "wait. i wasn't ready.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i have a system.", tags: [{ trait: 1, direction: "high" }] },
  { text: "i'm in charge of this.", tags: [{ trait: 1, direction: "high" }] },

  // --- Conscientiousness low ---
  { text: "i forgot what i wanted.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i lost my sock.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i forgot the word.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i lost my place.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i changed my mind.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i don't remember.", tags: [{ trait: 1, direction: "low" }] },
  { text: "i had it a second ago.", tags: [{ trait: 1, direction: "low" }] },
  { text: "what was i doing?", tags: [{ trait: 1, direction: "low" }] },
  { text: "i'll do it later.", tags: [{ trait: 1, direction: "low" }] },
  { text: "oops.", tags: [{ trait: 1, direction: "low" }] },

  // --- Extraversion high ---
  { text: "look at my drawing!", tags: [{ trait: 2, direction: "high" }] },
  { text: "watch me jump.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i'm a dinosaur.", tags: [{ trait: 2, direction: "high" }] },
  { text: "you can't catch me.", tags: [{ trait: 2, direction: "high" }] },
  { text: "look what i made.", tags: [{ trait: 2, direction: "high" }] },
  { text: "we can play together.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i want to show you something.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i'm coming!", tags: [{ trait: 2, direction: "high" }] },
  { text: "GUESS WHAT.", tags: [{ trait: 2, direction: "high" }] },
  { text: "hey. hey. hey. hey.", tags: [{ trait: 2, direction: "high" }] },
  { text: "watch this. are you watching? watch.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i told everyone.", tags: [{ trait: 2, direction: "high" }] },
  { text: "everybody come here.", tags: [{ trait: 2, direction: "high" }] },
  { text: "can they sleep over? they're already here.", tags: [{ trait: 2, direction: "high" }] },
  { text: "i need an audience.", tags: [{ trait: 2, direction: "high" }] },

  // --- Extraversion low ---
  { text: "it's too loud.", tags: [{ trait: 2, direction: "low" }] },
  { text: "i'm hiding.", tags: [{ trait: 2, direction: "low" }] },
  { text: "i'm still here.", tags: [{ trait: 2, direction: "low" }] },
  { text: "i'm waiting.", tags: [{ trait: 2, direction: "low" }] },
  { text: "this is mine.", tags: [{ trait: 2, direction: "low" }] },
  { text: "i was fine by myself.", tags: [{ trait: 2, direction: "low" }] },
  { text: "don't tell anyone i'm here.", tags: [{ trait: 2, direction: "low" }] },
  { text: "i need a minute.", tags: [{ trait: 2, direction: "low" }] },

  // --- Agreeableness high ---
  { text: "can i help?", tags: [{ trait: 3, direction: "high" }] },
  { text: "i promise.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i drew a picture of us.", tags: [{ trait: 3, direction: "high" }] },
  { text: "is everyone okay?", tags: [{ trait: 3, direction: "high" }] },
  { text: "i saved you the big one.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i made you a card. it's wet.", tags: [{ trait: 3, direction: "high" }] },
  { text: "do you want my blanket? you look cold.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i told them to be nice to you.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i'll share but i get to pick first.", tags: [{ trait: 3, direction: "high" }] },
  { text: "are you sad? you look sad.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i don't want anyone to feel left out.", tags: [{ trait: 3, direction: "high" }] },
  { text: "i forgive you. do you forgive me?", tags: [{ trait: 3, direction: "high" }] },

  // --- Agreeableness low ---
  { text: "it's not fair.", tags: [{ trait: 3, direction: "low" }] },
  { text: "i'm the boss.", tags: [{ trait: 3, direction: "low" }] },
  { text: "i can do it myself.", tags: [{ trait: 3, direction: "low" }] },
  { text: "not that straw.", tags: [{ trait: 3, direction: "low" }] },
  { text: "i don't want to.", tags: [{ trait: 3, direction: "low" }] },
  { text: "i had it first.", tags: [{ trait: 3, direction: "low" }] },
  { text: "that's mine and that's mine and that's also mine.", tags: [{ trait: 3, direction: "low" }] },
  { text: "no.", tags: [{ trait: 3, direction: "low" }] },
  { text: "you can't make me.", tags: [{ trait: 3, direction: "low" }] },
  { text: "why should i?", tags: [{ trait: 3, direction: "low" }] },

  // --- Neuroticism high ---
  { text: "why does it hurt?", tags: [{ trait: 4, direction: "high" }] },
  { text: "don't leave.", tags: [{ trait: 4, direction: "high" }] },
  { text: "are you there?", tags: [{ trait: 4, direction: "high" }] },
  { text: "where are you going?", tags: [{ trait: 4, direction: "high" }] },
  { text: "why do you have to leave?", tags: [{ trait: 4, direction: "high" }] },
  { text: "what if you forget to come back?", tags: [{ trait: 4, direction: "high" }] },
  { text: "i heard a noise.", tags: [{ trait: 4, direction: "high" }] },
  { text: "promise you're not mad.", tags: [{ trait: 4, direction: "high" }] },
  { text: "what if nobody likes me?", tags: [{ trait: 4, direction: "high" }] },
  { text: "i think something is under the bed.", tags: [{ trait: 4, direction: "high" }] },
  { text: "are you going to die?", tags: [{ trait: 4, direction: "high" }] },
  { text: "my stomach feels weird.", tags: [{ trait: 4, direction: "high" }] },
  { text: "i don't feel right.", tags: [{ trait: 4, direction: "high" }] },

  // --- Neuroticism low ---
  { text: "i'm not scared.", tags: [{ trait: 4, direction: "low" }] },
  { text: "i can handle it.", tags: [{ trait: 4, direction: "low" }] },
  { text: "i'm strong enough.", tags: [{ trait: 4, direction: "low" }] },
  { text: "i'm brave today.", tags: [{ trait: 4, direction: "low" }] },
  { text: "that's okay.", tags: [{ trait: 4, direction: "low" }] },
  { text: "it's fine.", tags: [{ trait: 4, direction: "low" }] },
  { text: "i fell but i'm okay.", tags: [{ trait: 4, direction: "low" }] },
  { text: "that didn't even hurt.", tags: [{ trait: 4, direction: "low" }] },

  // --- Neutral (no trait tags) ---
  { text: "can i have juice?", tags: [] },
  { text: "i'm not tired.", tags: [] },
  { text: "i don't like carrots but i like cake.", tags: [] },
  { text: "is that a bug or a dot?", tags: [] },
  { text: "i found a rock.", tags: [] },
  { text: "why can't i eat the crayons?", tags: [] },
  { text: "i'm hungry again.", tags: [] },
  { text: "the sky is crying.", tags: [] },
  { text: "can i touch that?", tags: [] },
  { text: "i want to fly.", tags: [] },
  { text: "where's my other shoe?", tags: [] },
  { text: "i'm bored.", tags: [] },
  { text: "the floor is lava.", tags: [] },
  { text: "can we get a cat?", tags: [] },
  { text: "the ice cream melted.", tags: [] },
  { text: "i found a penny.", tags: [] },
  { text: "i want to go faster.", tags: [] },
  { text: "i think it's broken.", tags: [] },
  { text: "that smells funny.", tags: [] },
  { text: "it's all gone.", tags: [] },
  { text: "i found a hole.", tags: [] },
  { text: "i have a secret.", tags: [] },
  { text: "that's not how it works.", tags: [] },
  { text: "i'm not done yet.", tags: [] },
  { text: "i don't want to go to bed.", tags: [] },
  { text: "one more story?", tags: [] },
  { text: "i think the moon follows us.", tags: [] },
  { text: "when i grow up.", tags: [] },
  { text: "i don't like this shirt.", tags: [] },
  { text: "i want to wear the red one.", tags: [] },
  { text: "find me if you can.", tags: [] },
  { text: "i'm right here.", tags: [] },
  { text: "i know a lot of things.", tags: [] },
  { text: "i'm teaching you.", tags: [] },
  { text: "this is important.", tags: [] },
  { text: "listen to me.", tags: [] },
  { text: "are you listening?", tags: [] },
  { text: "cross my heart.", tags: [] },
  { text: "it depends.", tags: [] },
  { text: "he melted.", tags: [] },
  { text: "that's a big number.", tags: [] },
  { text: "flush!", tags: [] },
  { text: "when i want to be.", tags: [] },
  { text: "beep beep.", tags: [] },
  { text: "this chair is mine.", tags: [] },
  { text: "i need a new spoon.", tags: [] },
  { text: "i want dessert first.", tags: [] },
  { text: "i want pancakes.", tags: [] },
  { text: "i pick both.", tags: [] },
  { text: "i'll think about it.", tags: [] },
  { text: "maybe tomorrow.", tags: [] },
  { text: "pick me up.", tags: [] },
  { text: "my feet hurt.", tags: [] },
  { text: "stay here.", tags: [] },
  { text: "this tastes like carpet.", tags: [] },
  { text: "i put a raisin in my nose.", tags: [] },
  { text: "my foot fell asleep and i don't like it.", tags: [] },
  { text: "i licked it so it's mine.", tags: [] },
  { text: "my shadow is following me.", tags: [] },
  { text: "that lady has a big nose.", tags: [] },
  { text: "i can see your bones.", tags: [] },
  { text: "i'm not crying. my eyes are leaking.", tags: [] },
  { text: "i need to tell you something. i forgot what.", tags: [] },
  { text: "the toilet made a weird noise.", tags: [] },
  { text: "how come you have hair in your nose?", tags: [] },
  { text: "if i eat a seed will a tree grow inside me?", tags: [] },
  { text: "why is your tummy so soft?", tags: [] },
  { text: "i don't want to be a person anymore. i want to be a cat.", tags: [] },
  { text: "why do you make that face when you sit down?", tags: [] },
  { text: "i'm saving this booger.", tags: [] },
  { text: "my brain is thinking too loud.", tags: [] },
  { text: "i swallowed a penny.", tags: [] },
  { text: "i can hear my blood.", tags: [] },
  { text: "why are your teeth yellow?", tags: [] },
  { text: "i ate it already. both of them.", tags: [] },
  { text: "that man is scary.", tags: [] },
  { text: "why does your knee do that?", tags: [] },
  { text: "i'm not small. you're just too big.", tags: [] },
  { text: "i need privacy.", tags: [] },
  { text: "my tongue is weird.", tags: [] },
  { text: "everything is spicy.", tags: [] },
  { text: "i wasn't picking my nose. i was checking.", tags: [] },
  { text: "the dog licked my face and i liked it.", tags: [] },
  { text: "you smell like outside.", tags: [] },
  { text: "i don't have bones right now.", tags: [] },
  { text: "i'm pretending i'm not here.", tags: [] },
  { text: "i said the wrong thing and now everyone is looking.", tags: [] },
  { text: "my tooth is doing something.", tags: [] },
  { text: "i forgot how to swallow.", tags: [] },

  // --- heartbreakers ---
  { text: "will you remember me when i'm big?", tags: [] },
  { text: "i don't want today to end.", tags: [] },
  { text: "can we do this again tomorrow?", tags: [] },
  { text: "i want to stay this size.", tags: [] },
  { text: "don't forget about me.", tags: [] },
  { text: "i want to be little forever.", tags: [] },
  { text: "will you still know me?", tags: [] },

  // --- childhood is hard ---
  { text: "nobody told me it would be like this.", tags: [] },
  { text: "i don't know how to make them like me.", tags: [] },
  { text: "why is everyone bigger than me?", tags: [] },
  { text: "i tried so hard and it didn't work.", tags: [] },
  { text: "nobody listened.", tags: [] },
  { text: "i don't know the rules yet.", tags: [] },
  { text: "everyone else already knows how.", tags: [] },

  // --- quiet guilt ---
  { text: "you're not listening.", tags: [] },
  { text: "you said you'd play with me.", tags: [] },
  { text: "you always say 'in a minute.'", tags: [] },
  { text: "you promised.", tags: [] },
  { text: "why are you always on your phone?", tags: [] },
  { text: "you forgot.", tags: [] },
  { text: "you said you'd be there.", tags: [] },

  // --- the kid trying to say something bigger than their vocabulary ---
  { text: "am i doing it right?", tags: [] },
  { text: "is this what everyone feels like?", tags: [] },
  { text: "i want to tell you something but i don't know what it is.", tags: [] },
  { text: "why does happy feel sad sometimes?", tags: [] },
  { text: "do other kids feel like this?", tags: [] },
  { text: "i think i'm different but i don't know how.", tags: [] },
  { text: "i had a thought and it scared me.", tags: [] },
  { text: "i don't know who to be yet.", tags: [] },
  { text: "sometimes i feel like i'm pretending.", tags: [] },
  { text: "i don't know how to say it.", tags: [] },
  { text: "i feel too much.", tags: [] },
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
