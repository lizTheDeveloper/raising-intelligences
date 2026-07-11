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

export type TrajectorySeverity = "none" | "mild" | "notable" | "significant";

export interface TrajectoryResult {
  severity: TrajectorySeverity;
  /**
   * NOT shown to the player. A seed for the World Manager (see
   * buildWorldManagerContext) to weave a supportive side character into a
   * future scene giving genuinely good, actionable advice — the character
   * never names or diagnoses the pattern, they just help. Only populated at
   * "notable"/"significant", and only queued after the pattern has held for
   * a few scenes in a row (see state-machine.ts TRAJECTORY_CHECKED) rather
   * than firing off a single ambiguous scene.
   */
  guidanceSeed: string;
}

const VALID_SEVERITIES: TrajectorySeverity[] = ["none", "mild", "notable", "significant"];

/**
 * Reads the child's whole-life Identity Document (already updated by the
 * Psychologist for this scene) and checks whether the developing pattern is
 * trending toward callousness, absence of remorse, or manipulation as a
 * primary relational strategy — as opposed to ordinary childhood traits
 * (stubbornness, anxiety, boundary-testing). Explicitly descriptive, not
 * diagnostic: no clinical or diagnostic labels, ever. Rather than telling
 * the player directly (a meta-narrator reflection breaks the game's own
 * "show, don't tell" rule for its story-generator), this produces a seed
 * that gets delivered diegetically — a recurring side character (varying
 * who, not always the same one) naturally giving good advice in a later
 * scene, without ever naming what prompted it.
 */
const TRAJECTORY_SYSTEM_PROMPT = `You are the Psychologist's trajectory reviewer for a parenting-simulation game. Right after the Identity Document is updated for this scene, read it as a whole and consider whether the child's developing pattern is trending toward callousness, absence of remorse, or manipulation as a primary relational strategy — as opposed to ordinary childhood traits (stubbornness, anxiety, giftedness, normal boundary-testing).

This is NOT a diagnosis and must never sound like one. Do not use clinical or diagnostic terms of any kind (no personality disorder names, no "conduct disorder", no "psychopathy", nothing from a diagnostic manual). Do not predict the child's adult outcome. Your output is never shown to the player directly — it's a seed for a separate story generator, which will later weave a supportive side character (a teacher, friend, relative, or other recurring figure — varied, not always the same one) into a future scene, having them naturally offer the parent genuinely good, specific, actionable advice. That character never names, labels, or diagnoses the pattern — they just help, the way a good mentor figure would, without knowing why it matters right now.

Rate severity:
- "none": ordinary childhood development, nothing notable
- "mild": normal difficult traits (stubborn, anxious, defiant) — not concerning
- "notable": a real relational pattern emerging that's worth addressing
- "significant": a sustained, escalating pattern across multiple scenes

Only for "notable" or "significant", write ONE sentence describing the specific, actionable parenting advice a supportive figure could give that would genuinely help — concrete guidance in plain language, e.g. "Advice about naming and validating the child's anger instead of redirecting away from it, so they don't learn their feelings don't matter" or "Advice about following through on empathy-building even when the child resists it at first, rather than giving up when it doesn't stick immediately."

Respond with ONLY a JSON object: {"severity": "none"|"mild"|"notable"|"significant", "guidance_seed": "string, empty unless severity is notable or significant"}`;

/**
 * Fails closed to "none" (no guidance queued) on any error or when there's
 * no Identity Document yet — a classifier outage should just mean no
 * guidance this scene, never something incorrect or garbled feeding into
 * the next scene's generation.
 */
export async function detectConcerningTrajectory(llm: LLMClient, state: GameState): Promise<TrajectoryResult> {
  if (!state.identityDocument) return { severity: "none", guidanceSeed: "" };

  try {
    const result = await llm.completeJson<{ severity?: unknown; guidance_seed?: unknown }>(
      TRAJECTORY_SYSTEM_PROMPT,
      `Identity Document:\n${state.identityDocument}`,
      "safety_check"
    );
    const severity = VALID_SEVERITIES.includes(result.severity as TrajectorySeverity)
      ? (result.severity as TrajectorySeverity)
      : "none";
    const showSeed = severity === "notable" || severity === "significant";
    return {
      severity,
      guidanceSeed: showSeed && typeof result.guidance_seed === "string" ? result.guidance_seed : "",
    };
  } catch (err) {
    logger.error("trajectory_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return { severity: "none", guidanceSeed: "" };
  }
}
