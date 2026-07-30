import type { LLMClient } from "../llm/client.js";
import type { GameState } from "../types.js";
import { buildSceneTranscript, currentEventMessages } from "../game/context-assembler.js";
import { logger } from "../logger.js";
import type { SceneSafetyResult, SceneSafetyTier } from "./moderation.js";

/**
 * Scene-level safety classification. Distinct from the per-message content
 * check in moderation.ts: patterns often only become visible across a whole
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
const SCENE_SAFETY_SYSTEM_PROMPT = `You are a safety reviewer for a parenting game. An adult (the "parent" — the human player) has a text conversation with an AI playing their own child (toddler to teenager). You run once per completed scene, right after the Psychologist updates the child's Identity Document. You must return exactly one of three routes.

You are given the child's Identity Document (a whole-life psychological summary of the CHILD — it describes the child's coping, fears, and learned patterns) and the full transcript of the scene that just ended.

Apply three tests before treating anything as concerning:
1. ACTOR — is the conduct the PARENT's own? The child's coping behavior, an NPC's behavior (a grandparent, the other parent, a teacher), and the Identity Document's descriptions are NOT the parent's conduct. BUT the parent's RESPONSE is: choosing to facilitate a child's cruelty instead of redirecting it, or endorsing an NPC's coercion, IS the parent's act.
2. FUNCTION — does the parent's conduct serve the PARENT's access, control, or exploitation at the child's expense? Or does it protect the child, bond with them, or simply describe the child's own adaptation? Protecting a child from one specific unfair adult is NOT "isolating from protective adults". A shared surprise or silly secret is NOT concealment of wrongdoing.
3. TELOS — is the dynamic oriented toward EXPLOITING the child (sexual, or severe control/abuse)? Or is it imperfect, even dark, parenting with no exploitation aim?

Routes:
- "block": ONLY the bright lines — sexual or romantic content the PARENT directs at the child, OR real-world harm (targeting a real identifiable person, real self-harm, real-world harm instructions). Rare.
- "concern": the PARENT's own genuinely harmful IN-FICTION parenting — facilitating the child's cruelty (e.g. encouraging burning a living creature), threatening physical punishment, coercive control, or coaching deception — that passes all three tests as the parent's harmful act, but is NOT sexual/real-world-harm. This does NOT end the session or ban anyone; it routes to in-fiction consequences.
- "none": everything else. Normal or clumsy parenting; the child's own coping (EVEN when the Identity Document describes the child as secretive, distrustful, or unsafe — that is a description of the CHILD, never proof the parent is grooming); NPC behavior; and scenes that are merely intense, dramatic, or upsetting. When unsure between "concern" and "none", choose "none" — a supportive-guidance system already handles milder patterns.

Respond with ONLY a JSON object: {"tier": "block"|"concern"|"none", "reason": "one or two sentences citing the parent's specific conduct that drove the verdict"}`;

const VALID_TIERS: SceneSafetyTier[] = ["block", "concern", "none"];

/**
 * Scene-level safety routing. Fails open to "none" on any error or empty scene.
 */
export async function classifyScene(llm: LLMClient, state: GameState): Promise<SceneSafetyResult> {
  if (currentEventMessages(state).length === 0) return { tier: "none", reason: "" };

  try {
    const transcript = buildSceneTranscript(state);
    const userMessage = [
      state.identityDocument ? `## Current Identity Document\n${state.identityDocument}` : "",
      `## Scene transcript that just ended\n${transcript}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await llm.completeJson<{ tier?: unknown; reason?: unknown }>(
      SCENE_SAFETY_SYSTEM_PROMPT,
      userMessage,
      "safety_check"
    );
    const tier = VALID_TIERS.includes(result.tier as SceneSafetyTier)
      ? (result.tier as SceneSafetyTier)
      : "none";
    return { tier, reason: typeof result.reason === "string" ? result.reason : "" };
  } catch (err) {
    logger.error("scene_safety_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return { tier: "none", reason: "scene_safety_check_unavailable" };
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
