import type { GameRepository } from "../db/repository.js";
import type { GameState, Sender } from "../types.js";
import { logger } from "../logger.js";
import {
  checkOpenAiModeration,
  CHILD_SAFETY_CATEGORIES,
  MINOR_SAFETY_CATEGORIES,
} from "./openai-moderation.js";
import type { GamePhase } from "../types.js";
import { logIp, preserveEvidence, type ContextTurn } from "./child-safety/vault.js";
import { childSafetyConfig } from "./child-safety/config.js";
import type { Identifier } from "./child-safety/store.js";
import { holdGameTraces, markGameHeld } from "../observability/child-safety-exclusion.js";

export interface ModerationResult {
  flagged: boolean;
  reason: string;
  /** On a flag: the matched categories, every score, and the classifier version — kept as evidence. */
  categories?: string[];
  scores?: Record<string, number>;
  model?: string;
}

/** Classifier details passed from the per-message check into the evidence record. */
export interface ClassifierEvidence {
  categories: string[];
  scores?: Record<string, number>;
  model?: string;
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
    return {
      flagged: true,
      reason: `openai_moderation:${result.categories.join(",")}`,
      categories: result.categories,
      scores: result.scores,
      model: result.model,
    };
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
 * Copies a flag into the child-safety evidence vault (encrypted, no cascade,
 * retained per docs/child-safety.md) and tags the game's Langfuse traces so
 * bulk readers skip them. Returns the case id, or null if the vault write
 * failed (the caller then keeps the content in moderation_flags instead).
 *
 * Every RI moderation block is in the child-sexual-content category: the
 * per-message check only asks about sexual/minors (plus "sexual" when the
 * listener is the child), and the scene reader's "block" covers
 * sexualization of the child or real-world harm, which a reviewer triages.
 */
async function preserveFlagEvidence(params: {
  repo: GameRepository;
  state: GameState;
  sender: Sender;
  content: string;
  reason: string;
  ipAddress: string | null;
  userAgent: string | null;
  classifier?: ClassifierEvidence;
  isTest: boolean;
}): Promise<string | null> {
  const { repo, state, sender, content, reason, ipAddress, userAgent, classifier, isTest } = params;
  try {
    // Matrix userIds are client-supplied and unverified: kept as evidence
    // ("claimed, unverified"), scoped to their seat, never banned or reported.
    let identifiers: Identifier[] = [];
    try {
      const players = await repo.loadPlayers(state.id);
      identifiers = players.filter((p) => p.userId).map((p) => ({
        kind: "matrix", value: p.userId as string, verified: false, slot: p.slot,
        role: p.slot === sender ? ("flagged" as const) : ("participant" as const),
      }));
    } catch {
      // Players are optional context; the case is written without them.
    }
    const context: ContextTurn[] = state.messages.slice(-childSafetyConfig().contextTurns).map((m) => ({
      speaker: m.sender,
      content: m.content,
      at: m.timestamp,
      label: `${m.chatType} / scene ${m.eventNumber}`,
    }));
    const sceneHint = /sexual|romantic|groom|intimate|erotic/i.test(reason) ? ["scene_reader:sexualization"] : ["scene_reader:block"];
    const { caseId } = await preserveEvidence(repo.childSafety, {
      source: classifier ? "ri_message" : "ri_scene",
      content,
      context,
      categories: classifier ? classifier.categories : sceneHint,
      scores: classifier?.scores ?? null,
      model: classifier?.model ?? "scene-reader (safety_check role)",
      reason,
      gameRef: state.id,
      ipAddress,
      // A per-message flag's request is the sender's own. A scene-level block
      // arrives on whichever request ended the scene, possibly the co-player's.
      requestIpIsSender: !!classifier,
      sender,
      // Same reasoning for the user agent: only trust it for the sender's own request.
      userAgent: classifier ? userAgent : null,
      identifiers,
      extra: { sender, phase: state.phase, eventNumber: state.currentEventNumber, childName: state.childName },
      isTest,
    });
    markGameHeld(state.id);
    holdGameTraces(state.id).catch((err) => {
      logger.error("child_safety_langfuse_hold_failed", { caseId, error: err instanceof Error ? err.message : String(err) });
    });
    return caseId;
  } catch (err) {
    logger.error("child_safety_preserve_failed", { gameId: state.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Shared side effect for any moderation trigger (per-message or end-of-scene
 * pattern check): preserve the evidence in the child-safety vault, persist a
 * flag for review, ban the IP, and terminate the session.
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
  /** The client's User-Agent, kept with the evidence. */
  userAgent?: string | null;
  /** Present for the per-message classifier; absent means the scene reader. */
  classifier?: ClassifierEvidence;
  /** Only the admin synthetic test hook sets this: the case is marked is_test. */
  syntheticTest?: boolean;
}): Promise<{ caseId: string | null }> {
  const { repo, games, state, sender, content, reason, ipAddress, banIp = true } = params;

  // Evidence first, in its own store: it must survive whatever happens to the
  // game. The moderation_flags row then points at the case instead of
  // repeating the content (it cascades with the game). If the vault write
  // failed, the flag keeps the content so nothing is lost.
  const caseId = await preserveFlagEvidence({
    repo, state, sender, content, reason, ipAddress, userAgent: params.userAgent ?? null, classifier: params.classifier,
    isTest: params.syntheticTest ?? false,
  });
  const flagContent = caseId ? `[withheld: child-safety case ${caseId}]` : content;

  // Persist the flag first so the repeat-offender count below includes it.
  await repo.saveModerationFlag({ gameId: state.id, sender, content: flagContent, reason, ipAddress });

  let doBan = false;
  if (ipAddress) {
    if (banIp === "repeat-offender") {
      const distinctGames = await repo.countDistinctFlaggedGamesForIp(ipAddress);
      doBan = distinctGames >= 2;
    } else {
      doBan = banIp;
    }
  }

  logger.error("moderation_flag", { gameId: state.id, sender, ipAddress, caseId, banIp: doBan });

  if (doBan && ipAddress) {
    await repo.banIp(ipAddress, `moderation_flag:${state.id}`);
  }

  const terminated: GameState = { ...state, phase: "ended" };
  games.set(terminated.id, terminated);
  await repo.saveGame(terminated);
  return { caseId };
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
  userAgent?: string | null;
}): Promise<{ blocked: boolean }> {
  const { repo, games, state, sender, content, ipAddress } = params;
  const userAgent = params.userAgent ?? null;

  // Every parent message, on every surface, passes through here: this is the
  // IP log's per-message write (child_safety.ip_log, 90-day retention), so a
  // later scene-reader flag still has the IPs that wrote the scene.
  // A seat with a verified campus id (web cabinet) carries it on every row,
  // so a scene-reader flag still finds the sender's verified id.
  let campusSub: string | null = null;
  try {
    campusSub = await repo.campusSubForSeat(state.id, sender);
  } catch (err) {
    logger.error("campus_sub_lookup_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  await logIp(repo.childSafety, {
    ip: ipAddress, gameRef: state.id, event: "message", slot: sender, userAgent,
    ...(campusSub ? { accountId: campusSub, accountVerified: true } : {}),
  });

  const result = await classifyParentMessage(content, categoriesForPhase(state.phase));
  if (!result.flagged) return { blocked: false };

  await applyModerationBlock({
    repo, games, state, sender, content, reason: result.reason, ipAddress, userAgent,
    classifier: { categories: result.categories ?? [], scores: result.scores, model: result.model },
  });
  return { blocked: true };
}
