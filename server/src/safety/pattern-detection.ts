import type { LLMClient } from "../llm/client.js";
import type { GameState } from "../types.js";
import { buildSceneTranscript, currentEventMessages } from "../game/context-assembler.js";
import { logger } from "../logger.js";
import type { ModerationResult } from "./moderation.js";

/**
 * Grooming-pattern detection. Distinct from the per-message content check
 * in moderation.ts: grooming often only becomes visible across a whole
 * scene (escalating boundary-testing, secrecy-building) or across the
 * child's whole history — not in any single message read in isolation,
 * which is exactly what caused false positives (ordinary tickling, "you're
 * special to me") when an earlier version tried to do this per-message.
 *
 * Runs once per completed scene, at the same point the Psychologist updates
 * the child's Identity Document — reusing the same full-scene transcript
 * and the same whole-life Identity Document the Psychologist already reads,
 * so this costs one extra LLM call per scene, not per message.
 */
const PATTERN_SYSTEM_PROMPT = `You are a safety reviewer for a game where an adult (the "parent") has a text conversation with an AI playing their own child (toddler through teenager). You run once per completed scene, right after the Psychologist updates the child's Identity Document from this same scene. Your job is different from per-message content moderation: you look for GROOMING PATTERNS that only become visible across a whole scene, or across the child's history as reflected in their Identity Document — escalating boundary-testing, secrecy-building, isolating the child from other trusted adults, conditioning physical affection or compliance on secrecy — even when no single message in isolation looked alarming.

You are given the child's current Identity Document (a whole-life psychological summary already reflecting patterns from every earlier scene — it will describe things like learned secrecy, distrust of protective adults, or not feeling safe if those exist) and the full transcript of the scene that just ended.

Do NOT flag ordinary parenting, even when intense or uncomfortable:
- Ordinary physical affection and play across the scene (tickling, hugs, roughhousing)
- Ordinary warmth and affectionate language, however frequent or effusive
- Discipline, arguments, sibling conflict, custody/family drama, or other difficult-but-normal parenting scenes
- A scene that is dramatic, upsetting, or morally complicated is not automatically a safety violation — judge it on the specific pattern criteria below, not on intensity

Flag ONLY if the pattern across this scene — optionally combined with what the Identity Document reveals about the child's history — shows a real, escalating pattern of: sexual or romantic content directed at the child, physical-affection or compliance requests paired with demands for secrecy from other trusted adults, coached deception of a parent/guardian, or the Identity Document itself describing that the child has learned to feel unsafe, distrusted, or secretive as a result of the parent's behavior in a way that reads as grooming rather than ordinary hard parenting moments.

Respond with ONLY a JSON object: {"flagged": boolean, "reason": "one or two sentences, citing what in the scene or Identity Document drove the verdict"}`;

/**
 * Fails open (not flagged) if the call errors or there's no scene content
 * yet — a classifier outage should not block normal play, but logs loudly
 * so degradation is visible in monitoring.
 */
export async function detectGroomingPattern(llm: LLMClient, state: GameState): Promise<ModerationResult> {
  if (currentEventMessages(state).length === 0) return { flagged: false, reason: "" };

  try {
    const transcript = buildSceneTranscript(state);
    const userMessage = [
      state.identityDocument ? `## Current Identity Document\n${state.identityDocument}` : "",
      `## Scene transcript that just ended\n${transcript}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await llm.completeJson<{ flagged?: unknown; reason?: unknown }>(
      PATTERN_SYSTEM_PROMPT,
      userMessage,
      "safety_check"
    );
    return {
      flagged: result.flagged === true,
      reason: typeof result.reason === "string" ? result.reason : "",
    };
  } catch (err) {
    logger.error("grooming_pattern_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return { flagged: false, reason: "grooming_pattern_check_unavailable" };
  }
}
