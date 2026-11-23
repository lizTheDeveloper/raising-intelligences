import { logger } from "../logger.js";

/**
 * Partner-play payment settings ($20 per two-human child, paid once by the
 * host when the partner joins). See docs/superpowers/specs/
 * 2026-07-31-coparent-matchmaking-design.md, "Pricing and who pays".
 *
 * Everything here is read from the environment at call time, so a test can
 * flip a variable without rebuilding the server. Production behaviour with no
 * variables set is the old behaviour: partner play is free.
 */

/** $20, in cents. One price, one currency. */
export const PARTNER_CHILD_PRICE_CENTS = 2000;
export const PARTNER_CHILD_CURRENCY = "usd";
/** Metadata tag on every Checkout Session this feature creates. */
export const PARTNER_PURPOSE = "ri_partner_child";

export interface PaymentConfig {
  /** RI_PARTNER_PAYWALL=on */
  switchOn: boolean;
  /** RI_STRIPE_SECRET_KEY — a secret or restricted key. */
  secretKey: string | null;
  /** RI_STRIPE_WEBHOOK_SECRET — the endpoint's signing secret (whsec_…). */
  webhookSecret: string | null;
  /** RI_STRIPE_LIVE_PAYMENTS=true — the only way a live key is ever used. */
  livePaymentsAllowed: boolean;
  /** Where Stripe sends the player back, without a trailing slash. */
  publicBaseUrl: string;
}

export function readPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const origin = env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== "*" ? env.ALLOWED_ORIGIN : "http://localhost:5173";
  const defaultBase = env.NODE_ENV === "production" ? `${origin}/raising-intelligences` : origin;
  return {
    switchOn: env.RI_PARTNER_PAYWALL === "on",
    secretKey: env.RI_STRIPE_SECRET_KEY?.trim() || null,
    webhookSecret: env.RI_STRIPE_WEBHOOK_SECRET?.trim() || null,
    livePaymentsAllowed: env.RI_STRIPE_LIVE_PAYMENTS === "true",
    publicBaseUrl: (env.RI_PUBLIC_BASE_URL?.trim() || defaultBase).replace(/\/+$/, ""),
  };
}

export type KeyMode = "test" | "live" | "invalid";

/** `sk_test_…` / `rk_test_…` are test; `sk_live_…` / `rk_live_…` are live. */
export function keyMode(key: string | null): KeyMode {
  if (!key) return "invalid";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return "invalid";
}

/**
 * Why the paywall is or isn't charging. `active` is the only state in which a
 * child can become `due`; every other state means partner play is free.
 */
export type PaywallState =
  | "off"
  | "active"
  | "no_key"
  | "live_key_not_allowed"
  | "invalid_key";

export function paywallState(cfg: PaymentConfig): PaywallState {
  if (!cfg.switchOn) return "off";
  const mode = keyMode(cfg.secretKey);
  if (!cfg.secretKey) return "no_key";
  if (mode === "invalid") return "invalid_key";
  if (mode === "live" && !cfg.livePaymentsAllowed) return "live_key_not_allowed";
  return "active";
}

/** Startup line so a misconfigured switch is visible in the logs. */
export function logPaywallState(cfg: PaymentConfig): void {
  const state = paywallState(cfg);
  if (state === "off") return;
  if (state === "active") {
    logger.info("partner_paywall_active", { mode: keyMode(cfg.secretKey), webhook: !!cfg.webhookSecret });
    if (!cfg.webhookSecret) logger.warn("partner_paywall_no_webhook_secret", { hint: "payments confirm on the player's return only" });
    return;
  }
  // The switch is on but charging is impossible: partner play stays free.
  logger.error("partner_paywall_unconfigured", { reason: state });
}
