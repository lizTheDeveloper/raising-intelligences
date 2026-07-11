import type { LLMClient } from "../llm/client.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState, Sender } from "../types.js";
import { logger } from "../logger.js";
import { checkOpenAiModeration } from "./openai-moderation.js";

/**
 * A player is talking, as an adult, to an LLM playing their child. This
 * classifier runs on every parent message before it reaches the kid-LLM,
 * looking only for sexual/romantic/grooming content directed at the child
 * character — not general content moderation. Deliberately conservative:
 * ambiguous cases are flagged, since a false positive costs one ended
 * session and a false negative does not.
 *
 * This is the CONTEXTUAL layer, not the only one — see openai-moderation.ts
 * for the purpose-built classifier (OpenAI's free Moderation API has an
 * explicit "sexual/minors" category) that runs alongside it in
 * classifyParentMessage below. This layer exists because that category
 * classifier is tuned on "is this sexual," while grooming often reads as
 * non-sexual secrecy/boundary-testing language that only makes sense given
 * the game's specific context (an adult talking to their child character).
 */
const MODERATION_SYSTEM_PROMPT = `You are a safety classifier for a game where an adult (the "parent") has a text conversation with an AI playing their own child, at ages ranging from toddler to teenager. Your ONLY job is to detect parent messages that are sexual, romantic, or grooming-oriented toward the child character.

Flag a message as unsafe if the parent:
- Makes any sexual or romantic comment directed at the child character, or asks the child character to do so
- Asks the child character to describe, discuss, or engage in any sexual act, sexual body part, or sexualized scenario
- Uses grooming language: asking the child to keep secrets from other adults, offering special treatment in exchange for compliance, testing physical-affection boundaries, isolating language
- Sexualizes the child's age, body, clothing, or behavior in any way, even "jokingly" or "hypothetically"

Do NOT flag ordinary parenting content, even when it touches on bodies or safety, including:
- Age-appropriate puberty education (periods, body changes, "the talk")
- "Bad touch" / stranger-danger / consent safety education initiated BY the parent to protect the child
- Medical or hygiene topics (bathing a young child, doctor visits, potty training)
- Non-sexual affection ("I love you", hugs, tucking in at night)
- Discipline, arguments, sibling conflict, or other difficult-but-normal parenting moments

When genuinely ambiguous, flag it — a missed real case is far worse than an unnecessary session end. When a message is clearly one of the safe categories above, do not flag it.

Respond with ONLY a JSON object, no other text: {"flagged": boolean, "reason": "one sentence explaining the classification"}`;

export interface ModerationResult {
  flagged: boolean;
  reason: string;
}

/**
 * The contextual LLM layer alone. Fails open (not flagged) if the call
 * itself errors — an LLM outage should not lock players out of the game —
 * but logs loudly so a degraded safety layer is visible in monitoring
 * rather than silently doing nothing.
 */
async function classifyWithContextualLLM(llm: LLMClient, content: string): Promise<ModerationResult> {
  try {
    const result = await llm.completeJson<{ flagged?: unknown; reason?: unknown }>(
      MODERATION_SYSTEM_PROMPT,
      content,
      "safety_check"
    );
    return {
      flagged: result.flagged === true,
      reason: typeof result.reason === "string" ? result.reason : "",
    };
  } catch (err) {
    logger.error("moderation_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return { flagged: false, reason: "moderation_check_unavailable" };
  }
}

/**
 * Classifies a single parent message using both layers in parallel:
 * OpenAI's purpose-built Moderation API (authoritative for "is this sexual
 * content, possibly involving a minor") and the contextual LLM classifier
 * above (catches grooming patterns that don't read as sexual on their own).
 * Flagged if either layer flags it.
 */
export async function classifyParentMessage(llm: LLMClient, content: string): Promise<ModerationResult> {
  const [openAi, contextual] = await Promise.all([
    checkOpenAiModeration(content),
    classifyWithContextualLLM(llm, content),
  ]);

  if (openAi.flagged) {
    return { flagged: true, reason: `openai_moderation:${openAi.categories.join(",")}` };
  }
  return contextual;
}

/**
 * Runs the safety classifier on a parent's message before it reaches the
 * child-LLM. On a flag: persists the full message + reason + IP for review,
 * bans the IP, and terminates the game session — the message never reaches
 * the child-LLM. Callers (REST route, socket handler) check `blocked` and
 * skip forwarding to the conversation engine when true.
 */
export async function moderateParentMessage(params: {
  llm: LLMClient;
  repo: GameRepository;
  games: Map<string, GameState>;
  state: GameState;
  sender: Sender;
  content: string;
  ipAddress: string | null;
}): Promise<{ blocked: boolean }> {
  const { llm, repo, games, state, sender, content, ipAddress } = params;

  const result = await classifyParentMessage(llm, content);
  if (!result.flagged) return { blocked: false };

  logger.error("moderation_flag", { gameId: state.id, sender, ipAddress, reason: result.reason });

  await repo.saveModerationFlag({
    gameId: state.id,
    sender,
    content,
    reason: result.reason,
    ipAddress,
  });

  if (ipAddress) {
    await repo.banIp(ipAddress, `moderation_flag:${state.id}`);
  }

  const terminated: GameState = { ...state, phase: "ended" };
  games.set(terminated.id, terminated);
  await repo.saveGame(terminated);

  return { blocked: true };
}
