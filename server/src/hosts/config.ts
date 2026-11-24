/**
 * Meetup host tools (spec: docs/superpowers/specs/2026-11-23-meetup-host-tools-design.md).
 *
 * A prototype: on only when RI_STRANGER_MODE=meetup, and every host, guest
 * reader and event is created by Liz in the admin. Off, every route here falls
 * through like a path that was never built, and stranger mode is exactly as
 * it was in 2.8.5.
 */

export const MIN_SHARE_SECRET_BYTES = 32;

export interface HostToolsConfig {
  /** RI_STRANGER_MODE=meetup. */
  enabled: boolean;
  /**
   * RI_SHARE_CODE_SECRET derives a share code's four words from its row id,
   * so the words are never stored. Missing or short: events with share codes
   * refuse to open (fail closed, like the stranger pepper).
   */
  shareCodeSecret: string | null;
  /**
   * RI_HOSTED_TRACE_RETENTION_DAYS: set only once a purge of hosted games'
   * traces actually runs. Unset, the card says traces are kept "until the
   * studio deletes it", which is true.
   */
  traceRetentionDays: number | null;
  /** Where LLM traces live, for the card's trace line. */
  traceWhere: "studio" | "langfuse_cloud";
  production: boolean;
  /** The version of the host agreement Liz records against each host. */
  agreementVersion: string;
}

export function readHostToolsConfig(env: NodeJS.ProcessEnv = process.env): HostToolsConfig {
  const secret = env.RI_SHARE_CODE_SECRET?.trim() || null;
  const days = Number(env.RI_HOSTED_TRACE_RETENTION_DAYS);
  const base = (env.LANGFUSE_BASEURL ?? env.LANGFUSE_HOST ?? "").toLowerCase();
  return {
    enabled: env.RI_STRANGER_MODE === "meetup",
    shareCodeSecret: secret && Buffer.byteLength(secret, "utf8") >= MIN_SHARE_SECRET_BYTES ? secret : null,
    traceRetentionDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : null,
    // Tracing only runs with an explicit base URL (observability/langfuse.ts);
    // the cloud is used only if that URL is Langfuse's own.
    traceWhere: base.includes("cloud.langfuse.com") ? "langfuse_cloud" : "studio",
    production: env.NODE_ENV === "production",
    agreementVersion: env.RI_HOST_AGREEMENT_VERSION?.trim() || "short-form-1",
  };
}

/** Events end within 14 days of opening (H17). */
export const MAX_EVENT_MS = 14 * 24 * 60 * 60 * 1000;
/** A share code can be redeemed for 14 days after it appears; then read for 30 days after redemption. */
export const SHARE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const CODE_REDEEM_MS = 14 * 24 * 60 * 60 * 1000;
export const CODE_ACCESS_MS = 30 * 24 * 60 * 60 * 1000;
/** A code appears 2 to 10 minutes after the second yes. */
export const REVEAL_MIN_MS = 2 * 60 * 1000;
export const REVEAL_MAX_MS = 10 * 60 * 1000;
/** The funnel is published once, at least this long after close. */
export const PUBLISH_AFTER_MS = 24 * 60 * 60 * 1000;
/** Redemption attempts per host person. */
export const REDEEM_PER_HOUR = 10;
export const REDEEM_PER_DAY = 30;
/** Every redemption answer takes at least this long. */
export const REDEEM_FLOOR_MS = 400;
