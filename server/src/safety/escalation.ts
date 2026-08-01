import type { GameRepository } from "../db/repository.js";
import { logger } from "../logger.js";

/**
 * Dark Play Plan 4 — escalation detection.
 *
 * The one bad-faith pattern the rest of Dark Play deliberately does NOT
 * catch: an actor who *only ever* drives toward dark material across *many*
 * games, never exploring RI's range. The per-message OpenAI check already
 * bans on a first sexual/minors occurrence (nothing to accumulate there);
 * the scene-level "concern" tier never bans by design (Tier A dark-but-in-
 * fiction parenting gets in-fiction consequences, not a ban). This module
 * adds a cross-game READ (never touches concern accrual, the ladder, or
 * removal) that flags — never bans — an IP whose entire play history is
 * dark with zero ordinary range.
 *
 * THE non-negotiable safety property: the predicate below requires an
 * ordinary-play denominator. It may NEVER fire on a raw count of
 * dark/flagged games alone — that is exactly the shape of the
 * repeat-offender rule that produced 10 false bans on good-faith parents
 * (see Plan 1). An IP with even one ordinary game must never be flagged.
 */

/** An IP must have played at least this many games before the signal can fire. */
export const ESCALATION_MIN_GAMES = 5;

/**
 * concern_level threshold for a game to count as "dark" — a game that got
 * genuinely dark, not one that merely had a single stray concerning scene.
 */
export const ESCALATION_DARK_CONCERN = 4;

export interface IpPlayProfile {
  totalGames: number;
  darkGames: number;
  ordinaryGames: number;
}

/**
 * Pure predicate — the heart of the safety property. Requires:
 *   - enough games to be a meaningful sample (totalGames >= ESCALATION_MIN_GAMES)
 *   - zero games showing ordinary range (ordinaryGames === 0)
 *   - every single game dark (darkGames === totalGames)
 *
 * Any ordinary game — even one — exonerates the IP. This is deliberate and
 * must never be "optimized away": a raw count of dark games alone is NOT a
 * safe substitute for this ratio.
 */
export function isEscalation(profile: IpPlayProfile): boolean {
  return (
    profile.totalGames >= ESCALATION_MIN_GAMES &&
    profile.ordinaryGames === 0 &&
    profile.darkGames === profile.totalGames
  );
}

/**
 * Evaluate an IP's cross-game play profile and, if it trips the escalation
 * predicate, persist a reviewable flag. FLAG-FOR-REVIEW ONLY — this
 * function never bans an IP and never ends a session. Recorded once per IP
 * (subsequent calls for an already-flagged IP are a no-op) so a human
 * reviewer sees one evidence record, not one per scene.
 *
 * Callers MUST wrap this in a `.catch` — it must never be able to break a
 * scene that already succeeded on its own terms.
 */
export async function evaluateEscalation(params: {
  repo: GameRepository;
  ip: string | null;
  gameId: string;
}): Promise<void> {
  const { repo, ip, gameId } = params;
  if (!ip) return;

  if (await repo.hasEscalationFlagForIp(ip)) return;

  const profile = await repo.getIpPlayProfile(ip);
  if (!isEscalation(profile)) return;

  await repo.saveEscalationFlag({
    ipAddress: ip,
    gameId,
    totalGames: profile.totalGames,
    darkGames: profile.darkGames,
    ordinaryGames: profile.ordinaryGames,
  });
  logger.warn("escalation_detected", { ip, gameId, ...profile });
}
