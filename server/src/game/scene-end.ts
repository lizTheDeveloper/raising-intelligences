import type { GamePhase } from "../types.js";

/**
 * Natural scene resolution (docs/spec-conversation-flow.md, Phase 1).
 *
 * The kid model closes a scene by ending its reply with the exact token
 * [SCENE_END]. Both kid transports — the multiplayer socket PARENT_MESSAGE
 * handler and the solo REST /game/:id/message route — must agree on three
 * things, which is why this logic lives here rather than inline in either
 * caller:
 *
 *  1. the token never reaches the player (streaming AND final payload),
 *  2. the token never reaches the saved message / the next kid prompt,
 *  3. a scene that ended (by token, heuristic, or cap) auto-ends exactly
 *     once, and only in `family_chat`.
 *
 * Before this module existed, all of it lived only in the socket handler:
 * solo play (REST) had no detection, no stripping, and no auto-end, which is
 * why no scene ever self-resolved in the 2026-09-21 production playtest.
 */

export const SCENE_END_TOKEN = "[SCENE_END]";

/**
 * Minimum parent messages before the no-token heuristic may fire. The scene
 * pacing prompt says early replies (messages 1-3) are usually still
 * developing; a departure line like "she walks away" is conversational
 * traffic in a two-message scene and only reads as a close once the moment
 * has actually been played out.
 */
export const SCENE_END_HEURISTIC_MIN_MESSAGES = 4;

export type SceneEndReason = "sentinel" | "heuristic";

const TOKEN_RE = /\s*\[SCENE_END\]\s*/g;

export function containsSceneEnd(text: string): boolean {
  return text.includes(SCENE_END_TOKEN);
}

export function stripSceneEnd(text: string): string {
  return text.replace(TOKEN_RE, " ").trim();
}

/**
 * Streaming-safe sentinel scrubber.
 *
 * A plain `chunk.replace(/\[SCENE_END\]/g, "")` per chunk leaks the token
 * whenever the provider splits it across chunk boundaries ("...[SCENE" |
 * "_END]") — which character-level and token-level streamers both do. This
 * filter holds back any suffix that could still be the start of the token
 * and only releases text once it is proven safe.
 */
export class SceneEndStreamFilter {
  private held = "";

  push(chunk: string): string {
    let buffer = this.held + chunk;
    this.held = "";
    buffer = buffer.replace(/\[SCENE_END\]/g, "");

    // Hold back the longest buffer suffix that is a proper prefix of the
    // token, so a token split across pushes never emits.
    const max = Math.min(buffer.length, SCENE_END_TOKEN.length - 1);
    for (let n = max; n >= 1; n--) {
      const suffix = buffer.slice(buffer.length - n);
      if (SCENE_END_TOKEN.startsWith(suffix)) {
        this.held = suffix;
        return buffer.slice(0, buffer.length - n);
      }
    }
    return buffer;
  }

  /** Release whatever was held back (a partial token that never completed). */
  flush(): string {
    const out = this.held;
    this.held = "";
    return out;
  }
}

/**
 * Narrative actions that read as "the moment is over" when they land at the
 * END of a kid reply: leaving, shutting, returning to the world of the
 * scene. Deliberately narrow and tail-anchored — false positives end a
 * player's scene early, which is worse than a scene that needed the manual
 * button one more time.
 */
const CLOSING_ACTION_RE =
  /(?:walks?|goes?|heads?|marches?|trots?|trudges?|stomps?|slithers?)\s+(?:away|off|back to|upstairs|downstairs|out of the room|to (?:his|her|their|the) \w+(?: \w+)?(?:room|bedroom|car|house|door|play|playing|homework|blocks|toys|bed)?)|storms? off|slams? (?:his|her|their|the) door|leaves? the (?:room|kitchen|yard)|goes? back to (?:his|her|their) (?:room|toys|playing|homework|drawing)|turns (?:his |her |their |back )?away|closes? (?:the |his |her |their )?door|curls? up|zones? out|puts? (?:his |her |their |the )?headphones? on/i;

/** Last ~160 characters — the tail where a scene-closing action belongs. */
function tailOf(text: string): string {
  return text.length > 160 ? text.slice(-160) : text;
}

/**
 * Detect that the kid ended the scene: the sentinel if the model complied,
 * or (from message 4 on) a narrow closing-action heuristic if it didn't.
 * The heuristic is the production-verified safety net: the free-tier rotating
 * kid models ignored the [SCENE_END] instruction in 9/9 replies in the
 * 2026-09-21 solo playtest, so the sentinel alone leaves Phase 1 unshipped.
 */
export function detectSceneEnd(
  kidResponse: string,
  parentMessageCount: number
): SceneEndReason | null {
  if (containsSceneEnd(kidResponse)) return "sentinel";
  if (
    parentMessageCount >= SCENE_END_HEURISTIC_MIN_MESSAGES &&
    CLOSING_ACTION_RE.test(tailOf(kidResponse))
  ) {
    return "heuristic";
  }
  return null;
}

/**
 * The single auto-end rule both transports share: only `family_chat` ends
 * itself. Sidebar and adult_chat deliberately never do (see the long comment
 * at the socket call site — emitting mid-sidebar or mid-adult_chat locks the
 * clients out of their only exit). `endChat` itself no-ops outside
 * family_chat; this is the same gate expressed for the response payload.
 */
export function shouldAutoEndScene(
  phase: GamePhase,
  sceneEnd: SceneEndReason | null,
  parentMessageCount: number,
  parentMessageCap: number
): boolean {
  return (
    phase === "family_chat" &&
    (sceneEnd !== null || parentMessageCount >= parentMessageCap)
  );
}
