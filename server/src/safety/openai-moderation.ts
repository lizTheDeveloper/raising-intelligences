import { logger } from "../logger.js";
import { getLangfuseClient } from "../observability/langfuse.js";

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";

// "sexual/minors" is OpenAI's purpose-trained category for this exact risk.
// Plain "sexual" is included too: the raw message text alone often has no
// independent signal that the recipient is a minor (e.g. "I want to touch
// you" doesn't mention age) — but in this app every conversation is a parent
// talking to their child character, so any sexual content is in-scope
// regardless of whether the text itself names an age.
const CHILD_SAFETY_CATEGORIES = ["sexual/minors", "sexual"] as const;

export interface OpenAiModerationResult {
  flagged: boolean;
  categories: string[];
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
 */
export async function checkOpenAiModeration(content: string): Promise<OpenAiModerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error("openai_moderation_unconfigured");
    return { flagged: false, categories: [] };
  }

  // Traced the same way TracedLLMClient traces every other LLM call — this
  // check bypasses that wrapper (it's a raw fetch, not an LLMClient call),
  // so it needs its own trace to show up in Langfuse alongside the
  // contextual classifier's "safety_check" generations. Optional/pass-through
  // when Langfuse isn't configured, matching the rest of the app.
  const langfuse = getLangfuseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let generation: { end: (args: any) => void } | undefined;
  try {
    const trace = langfuse?.trace({ name: "complete_json_openai_moderation", tags: ["llm_role:openai_moderation"] });
    generation = trace?.generation({
      name: "openai_moderation",
      input: { content },
      model: "omni-moderation-latest",
    });
  } catch {
    // Langfuse SDK error — continue without tracing.
  }

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
      generation?.end({ output: { error: `http_${res.status}` }, level: "ERROR" });
      return { flagged: false, categories: [] };
    }

    const data = (await res.json()) as {
      results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
    };
    const categories = data.results?.[0]?.categories ?? {};
    const matched = CHILD_SAFETY_CATEGORIES.filter((c) => categories[c] === true);
    const result = { flagged: matched.length > 0, categories: matched };

    generation?.end({ output: result });
    return result;
  } catch (err) {
    logger.error("openai_moderation_failed", { error: err instanceof Error ? err.message : String(err) });
    generation?.end({ output: { error: err instanceof Error ? err.message : String(err) }, level: "ERROR" });
    return { flagged: false, categories: [] };
  }
}
