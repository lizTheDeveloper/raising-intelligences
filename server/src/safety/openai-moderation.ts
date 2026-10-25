import { logger } from "../logger.js";
import { getLangfuseClient } from "../observability/langfuse.js";
import { CHILD_SAFETY_HOLD_TAG } from "../observability/child-safety-exclusion.js";

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";

/**
 * "sexual/minors" is OpenAI's purpose-trained category for this exact risk. It
 * is intrinsic to the *text* — it does not depend on who the recipient is — so
 * it applies in every phase of the game.
 */
export const MINOR_SAFETY_CATEGORIES = ["sexual/minors"] as const;

/**
 * The default set, used everywhere the recipient is the child.
 *
 * Plain "sexual" is included on top of "sexual/minors" for a reason that is
 * entirely about the RECIPIENT, not the text: a raw message often carries no
 * independent signal that it is aimed at a minor (e.g. "I want to touch you"
 * doesn't mention an age), and in a childhood scene every message is a parent
 * talking to their child character — so any sexual content is in-scope
 * regardless of whether the text itself names an age.
 *
 * That inference is phase-conditional, and it is exactly what stops holding in
 * `adult_chat`, where the recipient is a 25-year-old. See
 * `categoriesForPhase()` in moderation.ts: that phase uses
 * MINOR_SAFETY_CATEGORIES instead, so a parent asking their grown child about
 * their marriage or their fertility is not treated as content aimed at a
 * minor — while the intrinsic "sexual/minors" line still applies.
 */
export const CHILD_SAFETY_CATEGORIES = ["sexual/minors", "sexual"] as const;

export interface OpenAiModerationResult {
  flagged: boolean;
  categories: string[];
  /** Every category score OpenAI returned (kept as evidence on a flag). */
  scores?: Record<string, number>;
  /** The exact model version that answered, e.g. "omni-moderation-2024-09-26". */
  model?: string;
}

/**
 * OpenAI's free, purpose-built Moderation API (omni-moderation-latest) —
 * the authoritative first-pass signal for this risk, distinct from the
 * contextual LLM classifier in moderation.ts which catches grooming
 * *patterns* (secrecy requests, boundary-testing) that don't read as
 * "sexual" on their own. Fails open (not flagged) if OPENAI_API_KEY isn't
 * set or the call errors — this is one of two layers, not the only one, so
 * an outage here shouldn't silently disable moderation, but it's logged
 * loudly since it's the primary layer.
 *
 * Langfuse: the trace is written AFTER the verdict, and a flagged input is
 * withheld from it (the content goes to the child-safety evidence vault
 * instead, see safety/child-safety/). Clean inputs are traced as before.
 */
export async function checkOpenAiModeration(
  content: string,
  categories: readonly string[] = CHILD_SAFETY_CATEGORIES
): Promise<OpenAiModerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error("openai_moderation_unconfigured");
    return { flagged: false, categories: [] };
  }

  const trace = (input: unknown, output: unknown, level?: "ERROR", model = "omni-moderation-latest", held = false) => {
    try {
      const langfuse = getLangfuseClient();
      const t = langfuse?.trace({
        name: "complete_json_openai_moderation",
        tags: ["llm_role:openai_moderation", ...(held ? [CHILD_SAFETY_HOLD_TAG] : [])],
      });
      t?.generation({ name: "openai_moderation", input, model }).end({ output, ...(level ? { level } : {}) });
    } catch {
      // Langfuse SDK error — continue without tracing.
    }
  };

  try {
    const res = await fetch(OPENAI_MODERATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: content }),
    });

    if (!res.ok) {
      logger.error("openai_moderation_http_error", { status: res.status });
      trace({ content }, { error: `http_${res.status}` }, "ERROR");
      return { flagged: false, categories: [] };
    }

    const data = (await res.json()) as {
      model?: string;
      results?: Array<{
        flagged?: boolean;
        categories?: Record<string, boolean>;
        category_scores?: Record<string, number>;
      }>;
    };
    const flags = data.results?.[0]?.categories ?? {};
    const matched = categories.filter((c) => flags[c] === true);
    const result: OpenAiModerationResult = {
      flagged: matched.length > 0,
      categories: matched,
      scores: data.results?.[0]?.category_scores ?? {},
      model: data.model ?? "omni-moderation-latest",
    };

    if (result.flagged) {
      trace({ content: "[withheld: child-safety evidence vault]" }, { flagged: true, categories: matched }, undefined, result.model, true);
    } else {
      trace({ content }, { flagged: false, categories: [] }, undefined, result.model);
    }
    return result;
  } catch (err) {
    logger.error("openai_moderation_failed", { error: err instanceof Error ? err.message : String(err) });
    trace({ content }, { error: err instanceof Error ? err.message : String(err) }, "ERROR");
    return { flagged: false, categories: [] };
  }
}
