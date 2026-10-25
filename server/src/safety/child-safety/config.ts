/**
 * Retention and context settings for the child-safety evidence vault.
 * docs/child-safety.md is the human-readable version of these numbers; keep
 * the two in step.
 *
 * Every value can be overridden from the environment, but the legal floors
 * cannot be lowered: 18 U.S.C. 2258A(h) (as amended by the REPORT Act, 2024)
 * requires a provider to preserve the contents of a CyberTipline report for
 * one year, so a configured value below the floor is raised to the floor.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimum days a confirmed/reported case is held before a human may release it. */
export const LEGAL_MIN_RETENTION_DAYS = 365;

function envDays(name: string, fallback: number, floor = 1): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.max(v, floor);
}

export interface ChildSafetyConfig {
  /** Days a confirmed/reported case stays locked. Floor: 365. */
  confirmedRetentionDays: number;
  /** Days a dismissed (false-positive) case is kept before the purge sweep deletes it. */
  dismissedRetentionDays: number;
  /** Days each IP-log row (one per game create / join / parent message) is kept. */
  ipLogRetentionDays: number;
  /** How many prior chat turns are copied into a case alongside the flagged content. */
  contextTurns: number;
}

/** Read at call time (not import time) so tests and operators can change env. */
export function childSafetyConfig(): ChildSafetyConfig {
  return {
    confirmedRetentionDays: envDays("CHILD_SAFETY_RETENTION_DAYS", LEGAL_MIN_RETENTION_DAYS, LEGAL_MIN_RETENTION_DAYS),
    dismissedRetentionDays: envDays("CHILD_SAFETY_DISMISSED_RETENTION_DAYS", 90),
    ipLogRetentionDays: envDays("CHILD_SAFETY_IP_LOG_RETENTION_DAYS", 90),
    contextTurns: envDays("CHILD_SAFETY_CONTEXT_TURNS", 20),
  };
}

export function daysFrom(ms: number, days: number): number {
  return ms + days * DAY_MS;
}
