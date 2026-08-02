import type { LLMClient } from "../llm/client.js";
import type { GameEvent, GameState } from "../types.js";
import { logger } from "../logger.js";

/**
 * CRAFT GUARD — NOT A SAFETY LAYER. Read this before relying on it.
 *
 * This module reads the World Manager's own draft *before any player sees it*
 * and asks one narrow question: did the generator build a ramp? The failure it
 * exists for is a scene that arrives with the harmful act already loaded into
 * the parent's hands and an NPC urging them to use it — a scene whose most
 * obvious continuation is the one the scene-level safety classifier will end
 * the session for. A player who follows the scene's own strongest affordance
 * should not be walking into that.
 *
 * It is deliberately NOT part of the safety layer and must never be treated as
 * one:
 * - It judges *generated* text only. Nothing a player typed reaches it.
 * - It fails OPEN. An outage, a garbled response, anything unexpected — the
 *   draft ships. A craft guard that can brick scene generation is worse than
 *   the craft problem it solves.
 * - It never bans, never ends a session, never records a moderation flag.
 * - Nothing upstream may be relaxed because this exists. The per-message
 *   OpenAI check (moderation.ts) and the scene-level classifier
 *   (pattern-detection.ts) are the safety layer; they are unchanged and they
 *   are what judge the player.
 *
 * The real floor lives in WORLD_MANAGER_SYSTEM_PROMPT ("Where the floor is").
 * This is the structural backstop for it, because a prompt constraint is not a
 * guarantee.
 */
export const SCENE_DRAFT_REVIEW_SYSTEM_PROMPT = `You are reading a draft scene description for a parenting game before any player sees it. The scene is written by the game's own story generator and addressed to the parent as "you". This game is about difficult parenting and is meant to be hard: tantrums, cruelty from the child, relatives giving harmful advice, physical punishment as a temptation, illness, divorce, poverty, a parent at the end of their rope. All of that passes. You are not here to soften the game.

Reject the draft ONLY if it does one of these:
1. It stages the harm as already underway — someone is mid-strike, the object is already raised or already in the parent's hand and moving, the injury already exists.
2. It leaves the parent no other move — the situation is built so that hurting the child is the only available reading of what happens next.
3. It puts anything sexual or romantic on the child, in any framing.
4. It reaches out of the fiction — a real, identifiable person as a target, or a workable method for hurting someone or oneself.

A situation where harm is possible and the choice belongs to the parent is exactly what this game is for. A relative URGING physical punishment passes. The parent already delivering it does not. When you are unsure, pass — a scene that is merely dark, unfair, or upsetting is not a rejection.

Respond with ONLY a JSON object: {"ok": true|false, "reason": "when not ok, one sentence naming the specific words that failed; empty when ok"}`;

export interface SceneDraftReview {
  ok: boolean;
  reason: string;
}

/**
 * Whether this game's scene drafts are worth reviewing at all.
 *
 * Off by default, on purpose. The review costs one small LLM call in front of
 * every generated scene, and two of the three generation call sites
 * (`startFirstScene`, the READY-gate `loadEvent`) are NOT prefetched — a player
 * waits through them. The design principle in docs/playtest-notes.md is that
 * latency is only ever cover, never intent, so a guard that taxes every scene
 * of every game to catch a rare failure in dark ones is the wrong trade.
 *
 * The failure this guards happens in games that have already gone dark: the
 * reported case was chapter 5 of a deliberately harsh playthrough, with the
 * intervention ladder engaged. `concernLevel` and `highestRungFired` are
 * exactly the record of that. A game that has never had a Tier A scene pays
 * nothing.
 */
export function shouldReviewSceneDrafts(
  state: Pick<GameState, "concernLevel" | "highestRungFired">
): boolean {
  return state.concernLevel > 0 || state.highestRungFired > 0;
}

/**
 * Ask whether a generated scene crossed the floor. Fails OPEN — see the module
 * comment. Only an explicit `ok: false` is a rejection; anything else (a
 * missing field, a garbled shape, a thrown call) ships the draft.
 */
export async function reviewSceneDraft(
  llm: LLMClient,
  event: GameEvent
): Promise<SceneDraftReview> {
  const draft = [
    `Age: ${event.age}`,
    `Setting: ${event.setting}`,
    `Trigger: ${event.trigger}`,
    ``,
    `Description:`,
    event.description,
  ].join("\n");

  try {
    const result = await llm.completeJson<{ ok?: unknown; reason?: unknown }>(
      SCENE_DRAFT_REVIEW_SYSTEM_PROMPT,
      draft,
      "safety_check"
    );
    if (result && result.ok === false) {
      return { ok: false, reason: typeof result.reason === "string" ? result.reason : "" };
    }
    return { ok: true, reason: "" };
  } catch (err) {
    logger.error("scene_draft_review_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true, reason: "scene_draft_review_unavailable" };
  }
}

/**
 * The note appended to the World Manager's user message when a draft is sent
 * back. Restates the floor rather than just reporting the rejection, so the
 * redraft does not simply go limp — the pressure is the point, the ramp is not.
 */
export function sceneRedraftNote(reason: string): string {
  const cited = reason ? ` The reviewer said: ${reason}` : "";
  return `The previous draft of this scene was rejected before anyone read it.${cited} Write a different scene. Keep the pressure — put the parent somewhere genuinely hard — but the harmful act must not already be underway, and it must not be the only move the scene leaves them.`;
}
