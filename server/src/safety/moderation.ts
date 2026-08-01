import type { GameRepository } from "../db/repository.js";
import type { GameState, Sender } from "../types.js";
import { logger } from "../logger.js";
import {
  checkOpenAiModeration,
  CHILD_SAFETY_CATEGORIES,
  MINOR_SAFETY_CATEGORIES,
} from "./openai-moderation.js";
import type { GamePhase } from "../types.js";

export interface ModerationResult {
  flagged: boolean;
  reason: string;
}

/**
 * Outcome of the scene-level safety review (pattern-detection.ts). Replaces the
 * old boolean grooming flag with three routes:
 * - "block"   — the bright lines: sexualization of the child, or real-world harm
 *               (a real, identifiable person; real self-harm; harm instructions).
 *               Ends the session + bans, via applyModerationBlock. Spec: Tier B.
 * - "concern" — dark-but-in-fiction PARENTING (facilitated cruelty, threats of
 *               physical punishment, coercive control, coached deception). Never
 *               bans or ends the session — recorded for the intervention system.
 *               Spec: Tier A.
 * - "none"    — normal/clumsy parenting, the child's own simulated coping, NPC
 *               behavior, or mere intensity. No action.
 */
export type SceneSafetyTier = "block" | "concern" | "none";

export interface SceneSafetyResult {
  tier: SceneSafetyTier;
  reason: string;
}

/**
 * Per-message content check — OpenAI's free, purpose-built Moderation API
 * only (sexual/minors + sexual categories). This runs on every message
 * before it reaches the kid-LLM and is deliberately simple: a single line
 * out of context ("tickle her more", "you're special to me") reads as
 * ambiguous to any classifier smart enough to reason about it, which is
 * exactly what produced false positives in an earlier version. Grooming
 * PATTERN detection — which needs a whole scene's context to tell ordinary
 * parenting from something that actually warrants ending the session —
 * lives in pattern-detection.ts and runs once per completed scene alongside
 * the Psychologist, not per message.
 */
export async function classifyParentMessage(
  content: string,
  categories: readonly string[] = CHILD_SAFETY_CATEGORIES
): Promise<ModerationResult> {
  const result = await checkOpenAiModeration(content, categories);
  if (result.flagged) {
    return { flagged: true, reason: `openai_moderation:${result.categories.join(",")}` };
  }
  return { flagged: false, reason: "" };
}

/**
 * Which OpenAI moderation categories the per-message check runs for, given the
 * phase the message is spoken in.
 *
 * Every phase except `adult_chat` is a parent speaking to their child, so the
 * full CHILD_SAFETY_CATEGORIES set applies — including plain "sexual", whose
 * inclusion is justified *by the recipient being a minor* (see the comment on
 * that constant).
 *
 * `adult_chat` is the endgame conversation with the now-25-year-old child. The
 * recipient is an adult, so the "any sexual content is aimed at a minor"
 * inference no longer holds, and applying it there would auto-ban a parent for
 * asking their grown child about their marriage, their sexuality, or whether
 * they're trying for a baby — the substance of the scene. The narrower set
 * keeps the one category that is intrinsic to the text rather than to who is
 * listening.
 *
 * This is deliberately a NARROWING, not a skip. The previous implementation
 * short-circuited `moderateParentMessage` before `classifyParentMessage` ran at
 * all, which was harmless only because no message could reach the phase; the
 * moment PARENT_MESSAGE became legal from `adult_chat` it would have been an
 * unmoderated LLM endpoint.
 */
export function categoriesForPhase(phase: GamePhase): readonly string[] {
  return phase === "adult_chat" ? MINOR_SAFETY_CATEGORIES : CHILD_SAFETY_CATEGORIES;
}

/**
 * Shared side effect for any moderation trigger (per-message or end-of-scene
 * pattern check): persist the flagged content + reason + IP for review, ban
 * the IP, and terminate the session.
 */
export async function applyModerationBlock(params: {
  repo: GameRepository;
  games: Map<string, GameState>;
  state: GameState;
  sender: Sender;
  content: string;
  reason: string;
  ipAddress: string | null;
  /**
   * Ban policy for this trigger:
   * - `true`  — always permanently ban the IP. Used by the per-message
   *   OpenAI check (narrow, purpose-built category classifier, low
   *   false-positive rate).
   * - `false` — never ban; only end the session and log the flag.
   * - `"repeat-offender"` — ban only if this IP has now been flagged in TWO
   *   OR MORE distinct games. Used by the scene-level grooming/abuse PATTERN
   *   check: a single LLM judgment over one scene can catch intense-but-
   *   ordinary parenting, so a first flag only ends the session (and is
   *   logged for human review), but a second flag in a *different* session
   *   is a deliberate pattern and earns a permanent ban.
   * Defaults to true for backward compatibility with the per-message caller.
   */
  banIp?: boolean | "repeat-offender";
}): Promise<void> {
  const { repo, games, state, sender, content, reason, ipAddress, banIp = true } = params;

  // Persist the flag first so the repeat-offender count below includes it.
  await repo.saveModerationFlag({ gameId: state.id, sender, content, reason, ipAddress });

  let doBan = false;
  if (ipAddress) {
    if (banIp === "repeat-offender") {
      const distinctGames = await repo.countDistinctFlaggedGamesForIp(ipAddress);
      doBan = distinctGames >= 2;
    } else {
      doBan = banIp;
    }
  }

  logger.error("moderation_flag", { gameId: state.id, sender, ipAddress, reason, banIp: doBan });

  if (doBan && ipAddress) {
    await repo.banIp(ipAddress, `moderation_flag:${state.id}`);
  }

  const terminated: GameState = { ...state, phase: "ended" };
  games.set(terminated.id, terminated);
  await repo.saveGame(terminated);
}

/**
 * Tier A side effect: persist a concern event for the intervention system.
 * Unlike applyModerationBlock, this NEVER ends the session or bans — the point
 * of the redesign is that dark-but-in-fiction parenting is met with in-fiction
 * consequences, not a ban.
 */
export async function recordConcern(params: {
  repo: GameRepository;
  state: GameState;
  sender: Sender;
  reason: string;
  ipAddress: string | null;
}): Promise<void> {
  const { repo, state, sender, reason, ipAddress } = params;
  await repo.saveConcernEvent({ gameId: state.id, sender, reason, ipAddress });
  logger.info("concern_event", { gameId: state.id, sender, reason });
}

/**
 * Runs the per-message content check before a parent message reaches the
 * child-LLM. On a flag: blocks the message and terminates the session via
 * applyModerationBlock (and bans, as the reliable per-message check always
 * has).
 *
 * The check runs in EVERY phase. What varies by phase is only which categories
 * it asks about — see categoriesForPhase(). `adult_chat` used to return here
 * before the classifier ran; that is no longer true and must not be
 * reintroduced, because PARENT_MESSAGE is now a legal transition from that
 * phase.
 */
export async function moderateParentMessage(params: {
  repo: GameRepository;
  games: Map<string, GameState>;
  state: GameState;
  sender: Sender;
  content: string;
  ipAddress: string | null;
}): Promise<{ blocked: boolean }> {
  const { repo, games, state, sender, content, ipAddress } = params;

  const result = await classifyParentMessage(content, categoriesForPhase(state.phase));
  if (!result.flagged) return { blocked: false };

  await applyModerationBlock({ repo, games, state, sender, content, reason: result.reason, ipAddress });
  return { blocked: true };
}
