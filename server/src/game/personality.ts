import type { ParentPersonality } from "../types.js";
import type { LLMClient } from "../llm/client.js";
import { PERSONALITY_SEED_SYSTEM_PROMPT } from "../llm/prompts.js";

export type OceanScores = [number, number, number, number, number];

/**
 * Combine OCEAN trait scores from one or two parents into a child's scores.
 *
 * Two-parent: for each trait i,
 *   - if |p1[i] - p2[i]| <= 1 → randomly pick one parent's score
 *   - if diff >= 2 → wild card: random integer 1-4
 *
 * Single-parent: copy scores, apply +1 or -1 variance to exactly 2 randomly
 * selected distinct traits, clamped to 1-4.
 */
export function combineTraits(parent1: OceanScores, parent2?: OceanScores): OceanScores {
  if (parent2) {
    // Two-parent path
    const result = [0, 0, 0, 0, 0] as unknown as OceanScores;
    for (let i = 0; i < 5; i++) {
      const diff = Math.abs(parent1[i] - parent2[i]);
      if (diff <= 1) {
        // Genetic lottery: pick one parent's score
        result[i] = Math.random() < 0.5 ? parent1[i] : parent2[i];
      } else {
        // Wild card: random 1-4
        result[i] = Math.floor(Math.random() * 4) + 1;
      }
    }
    return result;
  } else {
    // Single-parent path: copy scores, then apply ±1 to exactly 2 distinct traits
    const result: OceanScores = [...parent1] as OceanScores;

    // Pick 2 distinct indices via partial Fisher-Yates
    const indices = [0, 1, 2, 3, 4];
    // Swap index 0 with a random position
    const i0 = Math.floor(Math.random() * 5);
    [indices[0], indices[i0]] = [indices[i0], indices[0]];
    // Swap index 1 with a random position from [1..4]
    const i1 = 1 + Math.floor(Math.random() * 4);
    [indices[1], indices[i1]] = [indices[i1], indices[1]];

    const trait0 = indices[0];
    const trait1 = indices[1];

    // Apply +1 or -1 to each selected trait
    const delta0 = Math.random() < 0.5 ? -1 : 1;
    const delta1 = Math.random() < 0.5 ? -1 : 1;

    result[trait0] = Math.max(1, Math.min(4, result[trait0] + delta0));
    result[trait1] = Math.max(1, Math.min(4, result[trait1] + delta1));

    return result;
  }
}

const OCEAN_LABELS = [
  "Openness",
  "Conscientiousness",
  "Extraversion",
  "Agreeableness",
  "Neuroticism",
];

function formatOceanScores(scores: OceanScores): string {
  return scores
    .map((score, i) => `${OCEAN_LABELS[i]}: ${score}/4`)
    .join(", ");
}

/**
 * Generate a personality seed document for the child from the parents'
 * OCEAN scores and confessional text. Returns a 150-200 word description
 * written in the child's internal voice.
 */
export async function generatePersonalitySeed(
  llm: LLMClient,
  childName: string,
  parent1: ParentPersonality,
  parent2?: ParentPersonality,
): Promise<string> {
  const kidScores = combineTraits(parent1.ocean, parent2?.ocean);

  const system = PERSONALITY_SEED_SYSTEM_PROMPT.replaceAll("{childName}", childName);

  const confessionals: string[] = [];
  if (parent1.confessional1) confessionals.push(`Parent 1: "${parent1.confessional1}"`);
  if (parent1.confessional2) confessionals.push(`Parent 1: "${parent1.confessional2}"`);
  if (parent2?.confessional1) confessionals.push(`Parent 2: "${parent2.confessional1}"`);
  if (parent2?.confessional2) confessionals.push(`Parent 2: "${parent2.confessional2}"`);

  const confessionalSection =
    confessionals.length > 0
      ? `\n\nEmotional themes from parent confessionals:\n${confessionals.join("\n")}`
      : "";

  const userMessage = `Child: ${childName}
OCEAN scores: ${formatOceanScores(kidScores)}${confessionalSection}

Generate the personality seed document for ${childName}.`;

  return llm.completeResponse(system, userMessage, undefined, "personality_seed");
}
