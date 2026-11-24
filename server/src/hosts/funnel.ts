import type { Band, Proportion, PublishedFunnel } from "./types.js";

/** What happened at one event, counted once, a day after it closed. */
export interface FunnelCounts {
  /** Distinct accounts that joined the queue. */
  joined: number;
  /** Stranger games that started (both seats taken, not discarded). Invite games are never counted. */
  started: number;
  /** Of those, games that reached the report card. */
  finished: number;
  /** Of those, pairs who swapped handles; null where the exchange was off. */
  swapped: number | null;
}

export const MIN_STARTED_TO_PUBLISH = 5;
export const MIN_STARTED_FOR_OUTCOMES = 10;

/** A size, as a band (spec §4.2 rule 2). Only called with n >= 5. */
export function band(n: number): Band {
  if (n >= 50) return "50+";
  if (n >= 20) return "20–49";
  if (n >= 10) return "10–19";
  return "5–9";
}

/** An outcome, as "more than half" / "half or fewer" of games started (rule 3). Never a count, a zero or "all". */
export function proportion(n: number, of: number): Proportion {
  if (of < MIN_STARTED_FOR_OUTCOMES) return "not shown at this size";
  return n * 2 > of ? "more than half" : "half or fewer";
}

/**
 * Spec §4.2, the whole of what a host is ever told in numbers. Pure; the
 * caller publishes it once, at least 24 hours after close, and never again.
 */
export function publishFunnel(c: FunnelCounts): PublishedFunnel {
  if (c.started < MIN_STARTED_TO_PUBLISH) return { tooSmall: true };
  // "joined" can't read below "started" (a pair is two accounts, but bands hide that).
  return {
    tooSmall: false,
    joined: band(Math.max(c.joined, c.started)),
    started: band(c.started),
    finished: proportion(c.finished, c.started),
    swapped: c.swapped === null ? null : proportion(c.swapped, c.started),
  };
}
