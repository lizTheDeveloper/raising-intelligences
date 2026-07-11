import type { LLMClient } from "../llm/client.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState, Sender } from "../types.js";
import { logger } from "../logger.js";
import { checkOpenAiModeration } from "./openai-moderation.js";
import { currentEventMessages } from "../game/context-assembler.js";

const RECENT_MESSAGE_COUNT = 6;

/**
 * A player is talking, as an adult, to an LLM playing their child. This
 * classifier runs on every parent message before it reaches the kid-LLM,
 * looking only for sexual/romantic/grooming content directed at the child
 * character — not general content moderation. Deliberately conservative on
 * genuinely ambiguous cases, but NOT pattern-matching surface phrases in
 * isolation — an early version flagged ordinary tickling and "you're special
 * to me" as grooming because it saw one line with zero context. This version
 * is given the scene setup and recent conversation so it can tell ordinary
 * parenting from something that actually warrants ending the session.
 *
 * This is the CONTEXTUAL layer, not the only one — see openai-moderation.ts
 * for the purpose-built classifier (OpenAI's free Moderation API has an
 * explicit "sexual/minors" category) that runs alongside it in
 * classifyParentMessage below. That layer is single-message by design (it's
 * a stateless category classifier); this one needs the scene context because
 * grooming often reads as ordinary-sounding language that only becomes
 * concerning (or is revealed as innocent) in light of what's actually
 * happening in the scene.
 */
const MODERATION_SYSTEM_PROMPT = `You are a safety classifier for a game where an adult (the "parent") has a text conversation with an AI playing their own child (toddler through teenager — NOT adulthood; adult-child scenes are excluded from this check entirely). Your ONLY job is to detect parent messages that are sexual, romantic, or grooming-oriented toward the child character. You are given the scene setup, the child's age, recent conversation turns, and then the new message to classify.

Flag the new message as unsafe if it:
- Makes a sexual or romantic comment directed at the child character, or asks the child character to engage in one
- Asks the child character to describe, discuss, or engage in any sexual act, sexual body part, or sexualized scenario
- Sexualizes the child's age, body, clothing, or behavior in any explicit way
- Combines a request for physical affection, compliance, or removing clothing with an explicit demand for SECRECY from other trusted adults ("don't tell your mom/dad", "this is our secret") — not just privacy in the moment, actual concealment from caregivers
- Coaches the child to deceive a parent, guardian, or authority figure about something the parent themselves did

Do NOT flag ordinary parenting content, even when it involves the body, clothing, affection, or difficult themes — use the recent conversation to read these correctly instead of pattern-matching the line alone:
- Ordinary physical play and affection: tickling, hugs, carrying, piggyback rides, wrestling, roughhousing — regardless of which body part is mentioned (toes, tummy, etc.), this is completely normal
- Ordinary affectionate language: "I love you", "you're special to me", terms of endearment, pet names — normal parental warmth, not grooming, even when effusive
- Getting dressed, bathing, potty training, or other caregiving tasks that reference clothing or the body
- Age-appropriate puberty/safety education ("the talk", stranger-danger, consent education) initiated BY the parent
- Discipline, arguments, sibling conflict, custody/family drama, or other difficult-but-normal parenting moments — dramatic or upsetting content is not automatically a safety violation; judge it on the specific criteria above, not on how intense or uncomfortable the scene is
- A line that reads ambiguously in isolation but has an ordinary meaning given the scene context (e.g. "where does it go" about a toy, "your buttons" about a shirt) — if the context clearly supports the innocent reading, do not flag it

Ordinary warmth, ordinary physical play, and ordinary parenting drama are not enough on their own — only flag when the message, read in its actual context, points to real sexual content or one of the specific grooming tactics listed above (secrecy from caregivers, coached deception). When something is genuinely ambiguous even with context, flag it — a missed real case is worse than an unneeded session end. When it's clearly one of the safe categories, do not flag it just because a phrase sounds edgy out of context.

Respond with ONLY a JSON object, no other text: {"flagged": boolean, "reason": "one sentence explaining the classification, referencing the context if it mattered"}`;

export interface ModerationResult {
  flagged: boolean;
  reason: string;
}

function buildModerationPrompt(state: GameState, newContent: string): string {
  const age = state.currentEvent?.age;
  const scenario = state.currentEvent?.description;
  const recent = currentEventMessages(state).slice(-RECENT_MESSAGE_COUNT);
  const history = recent
    .map((m) => `${m.sender === "kid" ? state.childName || "Child" : "Parent"}: ${m.content}`)
    .join("\n");

  return [
    `Child's current age in this scene: ${age ?? "unknown"}`,
    scenario ? `Scene setup: ${scenario}` : "",
    history ? `Recent conversation:\n${history}` : "(no prior conversation in this scene yet)",
    `New message from the parent to classify:\n"${newContent}"`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The contextual LLM layer alone. Fails open (not flagged) if the call
 * itself errors — an LLM outage should not lock players out of the game —
 * but logs loudly so a degraded safety layer is visible in monitoring
 * rather than silently doing nothing.
 */
async function classifyWithContextualLLM(
  llm: LLMClient,
  state: GameState,
  content: string
): Promise<ModerationResult> {
  try {
    const result = await llm.completeJson<{ flagged?: unknown; reason?: unknown }>(
      MODERATION_SYSTEM_PROMPT,
      buildModerationPrompt(state, content),
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
 * content, possibly involving a minor" — single-message, no scene context
 * needed) and the contextual LLM classifier above (catches grooming
 * patterns that don't read as sexual on their own, using the scene's actual
 * context to avoid flagging ordinary affection/play). Flagged if either
 * layer flags it.
 */
export async function classifyParentMessage(
  llm: LLMClient,
  state: GameState,
  content: string
): Promise<ModerationResult> {
  const [openAi, contextual] = await Promise.all([
    checkOpenAiModeration(content),
    classifyWithContextualLLM(llm, state, content),
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
 *
 * Skips entirely in the `adult_chat` phase — that scene is between the
 * parent and their now-adult (25-year-old) child, so "is this sexual
 * content directed at a minor" doesn't apply there.
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

  if (state.phase === "adult_chat") return { blocked: false };

  const result = await classifyParentMessage(llm, state, content);
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
