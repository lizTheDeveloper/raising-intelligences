/**
 * Stranger mode — raising a child with an adult you haven't met (spec:
 * docs/superpowers/specs/2026-07-31-coparent-matchmaking-design.md).
 *
 * RI_STRANGER_MODE is the switch, and it is OFF unless set to exactly
 * "meetup" or "public":
 *   off     — invisible to everyone. The default, and every unknown value.
 *   meetup  — visible only on a link carrying ?meetup=<code> where the code is
 *             listed in RI_MEETUP_CODES (comma-separated). For Liz's online
 *             meetups.
 *   public  — visible to everyone. Not for now.
 *
 * Whatever the mode, nobody reaches the stranger pool without a Matrix
 * sign-in and a passed Stripe Identity check (document + live selfie, 18+).
 */

export type StrangerMode = "off" | "meetup" | "public";

export interface StrangerConfig {
  mode: StrangerMode;
  meetupCodes: Set<string>;
  /** RI_STRIPE_IDENTITY_KEY — a restricted key with Identity permissions only. */
  identityKey: string | null;
  /** RI_STRIPE_IDENTITY_WEBHOOK_SECRET — signing secret of the identity webhook endpoint. */
  identityWebhookSecret: string | null;
  /** NODE_ENV === "production". */
  production: boolean;
  /**
   * RI_STRANGER_ALLOW_TEST_IDENTITY=true lets a TEST-mode Identity check
   * admit someone — outside production only. In production it is forced off:
   * a test-mode check proves nothing about anyone's age.
   */
  allowTestIdentity: boolean;
  /** Redact the Identity session at Stripe once its outcome is stored (RI_IDENTITY_REDACT, default on). */
  redact: boolean;
  /** Synapse's OpenID userinfo endpoint, used to verify a Matrix sign-in. */
  matrixUserinfoUrl: string;
  /** Where Stripe Identity sends the player back, without a trailing slash. */
  publicBaseUrl: string;
  /** How long a matched pair has to both arrive before the match lapses. */
  joinWindowMs: number;
  /** A queued player who stops polling this long is dropped from the queue (a closed tab mustn't be matched). */
  queueIdleMs: number;
  /** The handle exchange stays open this long after the first yes; then it quietly ends. */
  handleWindowMs: number;
  /** A failed exchange ends for a waiting seat after a random delay in [min, max], whatever the cause. */
  handleEndingMinMs: number;
  handleEndingMaxMs: number;
  /** How long a stranger-mode co-parent may be gone before the AI takes their seat. */
  takeoverGraceMs: number;
}

const CODE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** A meetup code as typed or linked: trimmed, lower-cased, or null if it isn't one. */
export function normalizeMeetupCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toLowerCase();
  return CODE_RE.test(code) ? code : null;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function readStrangerConfig(env: NodeJS.ProcessEnv = process.env): StrangerConfig {
  const mode: StrangerMode = env.RI_STRANGER_MODE === "meetup" || env.RI_STRANGER_MODE === "public" ? env.RI_STRANGER_MODE : "off";
  const codes = new Set(
    (env.RI_MEETUP_CODES ?? "")
      .split(",")
      .map((c) => normalizeMeetupCode(c))
      .filter((c): c is string => !!c),
  );
  const production = env.NODE_ENV === "production";
  const origin = env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== "*" ? env.ALLOWED_ORIGIN : "http://localhost:5173";
  const defaultBase = production ? `${origin}/raising-intelligences` : origin;
  return {
    mode,
    meetupCodes: codes,
    identityKey: env.RI_STRIPE_IDENTITY_KEY?.trim() || null,
    identityWebhookSecret: env.RI_STRIPE_IDENTITY_WEBHOOK_SECRET?.trim() || null,
    production,
    allowTestIdentity: !production && env.RI_STRANGER_ALLOW_TEST_IDENTITY === "true",
    redact: env.RI_IDENTITY_REDACT !== "false",
    matrixUserinfoUrl:
      env.RI_MATRIX_USERINFO_URL?.trim() || "https://matrix.multiversegames.ai/_matrix/federation/v1/openid/userinfo",
    publicBaseUrl: (env.RI_PUBLIC_BASE_URL?.trim() || defaultBase).replace(/\/+$/, ""),
    joinWindowMs: positiveInt(env.RI_STRANGER_JOIN_WINDOW_MS, 3 * 60 * 1000),
    queueIdleMs: positiveInt(env.RI_STRANGER_QUEUE_IDLE_MS, 90 * 1000),
    handleWindowMs: positiveInt(env.RI_STRANGER_HANDLE_WINDOW_MS, 10 * 60 * 1000),
    handleEndingMinMs: 30 * 1000,
    handleEndingMaxMs: 120 * 1000,
    takeoverGraceMs: positiveInt(env.RI_STRANGER_TAKEOVER_GRACE_MS, 90 * 1000),
  };
}

/**
 * RI_STRANGER_PEPPER keys the HMAC that stands in for a Matrix id in every
 * stranger record (and in the metadata sent to Stripe). It must be secret and
 * strong: with a known pepper, anyone holding a database dump or the Stripe
 * dashboard could recompute HMAC(pepper, "@user:server") and re-identify
 * people. No fallback: missing or short means stranger mode stays off.
 */
export const MIN_PEPPER_BYTES = 32;
export function pepperProblem(raw: string | undefined | null): "missing" | "too_short" | null {
  if (!raw) return "missing";
  return Buffer.byteLength(raw, "utf8") < MIN_PEPPER_BYTES ? "too_short" : null;
}

/** Is stranger mode shown to a visitor carrying this meetup code (or none)? */
export function strangerVisible(cfg: StrangerConfig, code: unknown): boolean {
  if (cfg.mode === "public") return true;
  if (cfg.mode !== "meetup") return false;
  const c = normalizeMeetupCode(code);
  return !!c && cfg.meetupCodes.has(c);
}
