import type { GameRepository } from "../db/repository.js";
import type { GameState, Sender } from "../types.js";
import { logger } from "../logger.js";
import { checkOpenAiModeration } from "./openai-moderation.js";

export interface ModerationResult {
  flagged: boolean;
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
export async function classifyParentMessage(content: string): Promise<ModerationResult> {
  const result = await checkOpenAiModeration(content);
  if (result.flagged) {
    return { flagged: true, reason: `openai_moderation:${result.categories.join(",")}` };
  }
  return { flagged: false, reason: "" };
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
}): Promise<void> {
  const { repo, games, state, sender, content, reason, ipAddress } = params;

  logger.error("moderation_flag", { gameId: state.id, sender, ipAddress, reason });

  await repo.saveModerationFlag({ gameId: state.id, sender, content, reason, ipAddress });

  if (ipAddress) {
    await repo.banIp(ipAddress, `moderation_flag:${state.id}`);
  }

  const terminated: GameState = { ...state, phase: "ended" };
  games.set(terminated.id, terminated);
  await repo.saveGame(terminated);
}

/**
 * Runs the per-message content check before a parent message reaches the
 * child-LLM. On a flag: blocks the message and terminates the session via
 * applyModerationBlock. Skips entirely in the `adult_chat` phase — that
 * scene is between the parent and their now-adult (25-year-old) child, so
 * "is this sexual content directed at a minor" doesn't apply there.
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

  if (state.phase === "adult_chat") return { blocked: false };

  const result = await classifyParentMessage(content);
  if (!result.flagged) return { blocked: false };

  await applyModerationBlock({ repo, games, state, sender, content, reason: result.reason, ipAddress });
  return { blocked: true };
}
