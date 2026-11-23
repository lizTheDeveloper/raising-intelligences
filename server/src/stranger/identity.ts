import { createHmac } from "node:crypto";
import { logger } from "../logger.js";
import { createStripeRest, type StripeParams, type StripeRest } from "../payments/stripe.js";
import type { ChildSafetyStore } from "../safety/child-safety/store.js";
import type { StrangerConfig } from "./config.js";
import type { StrangerStore } from "./store.js";

/**
 * The hard line: no minor ever reaches the stranger pool.
 *
 * Every stranger-mode player — host or not, payer or not — passes a Stripe
 * Identity check: a government ID plus a live selfie matched to it. We ask
 * Stripe for the date of birth on the document, compute 18+ on the spot, and
 * keep ONLY the outcome. Then the Identity session is redacted at Stripe
 * (RI_IDENTITY_REDACT, on by default), so the document and selfie don't sit
 * there either.
 *
 * Fail closed everywhere: an unfinished check, an unreadable date of birth,
 * a test-mode check in production, a Stripe outage — none of them admit
 * anyone. A minor result is final for that Matrix account.
 */

/**
 * The biometric/ID consent text version. Bump it whenever the consent screen
 * (client/src/components/StrangerConsent.tsx) changes, so players re-consent.
 */
export const CONSENT_VERSION = "2026-11-22.1";

/** A day's checks per account: enough for a blurry photo or two, not a brute force. */
export const MAX_CHECKS_PER_DAY = 3;

export interface VerificationSession {
  id: string;
  status: "requires_input" | "processing" | "verified" | "canceled";
  url: string | null;
  livemode: boolean;
  metadata?: Record<string, string>;
  last_error: { code?: string; reason?: string } | null;
  verified_outputs?: { dob?: { day: number | null; month: number | null; year: number | null } | null } | null;
}

/** What age verification needs from Stripe Identity. Faked in tests. */
export interface IdentityApi {
  createVerificationSession(params: StripeParams, idempotencyKey?: string): Promise<VerificationSession>;
  retrieveVerificationSession(id: string, expandDob: boolean): Promise<VerificationSession>;
  redactVerificationSession(id: string): Promise<void>;
}

export function createIdentityApi(rest: StripeRest): IdentityApi {
  return {
    createVerificationSession: (params, key) =>
      rest.request<VerificationSession>("POST", "/v1/identity/verification_sessions", params, key),
    retrieveVerificationSession: (id, expandDob) =>
      rest.request<VerificationSession>(
        "GET",
        `/v1/identity/verification_sessions/${encodeURIComponent(id)}`,
        expandDob ? { "expand[]": "verified_outputs.dob" } : {},
      ),
    redactVerificationSession: async (id) => {
      await rest.request("POST", `/v1/identity/verification_sessions/${encodeURIComponent(id)}/redact`);
    },
  };
}

/** Whole years between a date of birth and `now` (UTC). 29 February turns over on 1 March. */
export function ageOn(dob: { year: number; month: number; day: number }, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  let age = y - dob.year;
  if (m < dob.month || (m === dob.month && d < dob.day)) age--;
  return age;
}

export type CheckOutcome = "adult" | "minor" | "unverified";
export type PoolRefusal = "unverified" | "minor" | "test_mode_verification" | "banned" | "not_configured";

interface Deps {
  store: StrangerStore;
  config: () => StrangerConfig;
  childSafety: ChildSafetyStore;
  /** Injected in tests; otherwise built from RI_STRIPE_IDENTITY_KEY. */
  api?: IdentityApi;
  now?: () => number;
  /** HMAC key for subject hashes. RI_STRANGER_PEPPER, with a fixed fallback. */
  pepper?: string;
}

export class AgeVerification {
  private readonly store: StrangerStore;
  private readonly config: () => StrangerConfig;
  private readonly childSafety: ChildSafetyStore;
  private readonly injectedApi?: IdentityApi;
  private readonly now: () => number;
  private readonly pepper: string;

  constructor(deps: Deps) {
    this.store = deps.store;
    this.config = deps.config;
    this.childSafety = deps.childSafety;
    this.injectedApi = deps.api;
    this.now = deps.now ?? Date.now;
    this.pepper = deps.pepper ?? process.env.RI_STRANGER_PEPPER ?? "ri-stranger-subject-v1";
  }

  /** The opaque per-account id used in every stranger record and sent to Stripe. */
  async subjectHash(matrixId: string): Promise<string> {
    return createHmac("sha256", this.pepper).update(matrixId).digest("hex");
  }

  private api(): IdentityApi | null {
    if (this.injectedApi) return this.injectedApi;
    const key = this.config().identityKey;
    if (!key || !/^(sk|rk)_(live|test)_/.test(key)) return null;
    return createIdentityApi(createStripeRest(key));
  }

  configured(): boolean {
    return this.api() !== null;
  }

  async recordConsent(matrixId: string, version: string): Promise<boolean> {
    if (version !== CONSENT_VERSION) return false;
    await this.store.recordConsent({ subject: await this.subjectHash(matrixId), version, at: this.now() });
    return true;
  }

  async hasConsent(matrixId: string): Promise<boolean> {
    const c = await this.store.getConsent(await this.subjectHash(matrixId));
    return c?.version === CONSENT_VERSION;
  }

  /** What the stored record says, without asking Stripe. */
  async storedOutcome(matrixId: string): Promise<"adult" | "minor" | null> {
    return (await this.store.getVerification(await this.subjectHash(matrixId)))?.outcome ?? null;
  }

  /** Start an ID + selfie check. Returns Stripe's hosted URL. */
  async start(matrixId: string, meetupCode: string | null): Promise<{ url: string } | { error: string; reason: string }> {
    const subject = await this.subjectHash(matrixId);
    const api = this.api();
    if (!api) return { error: "Age checks aren't set up yet.", reason: "not_configured" };
    if (!(await this.hasConsent(matrixId))) return { error: "Please read and agree to the ID check first.", reason: "no_consent" };
    const existing = await this.store.getVerification(subject);
    if (existing?.outcome === "minor") return { error: "Stranger mode is for adults only.", reason: "minor" };
    const since = this.now() - 24 * 60 * 60 * 1000;
    if ((await this.store.countVerificationSessionsSince(subject, since)) >= MAX_CHECKS_PER_DAY) {
      return { error: "That's the most checks for one day. Try again tomorrow.", reason: "rate_limited" };
    }
    const base = this.config().publicBaseUrl;
    const returnUrl = `${base}/?stranger=identity${meetupCode ? `&meetup=${encodeURIComponent(meetupCode)}` : ""}`;
    // Only an opaque hash goes to Stripe: no Matrix id, no name, no email.
    const session = await api.createVerificationSession({
      type: "document",
      "options[document][require_matching_selfie]": true,
      "options[document][require_live_capture]": true,
      "metadata[ri_purpose]": "ri_stranger_age",
      "metadata[ri_subject]": subject,
      return_url: returnUrl,
    });
    await this.store.addVerificationSession({ sessionId: session.id, subject, createdAt: this.now() });
    if (!session.url) return { error: "The ID check didn't open. Try again.", reason: "no_url" };
    logger.info("stranger_identity_started", { livemode: session.livemode });
    return { url: session.url };
  }

  /** The player's return from Stripe: read their latest check from Stripe and settle it. */
  async check(matrixId: string): Promise<CheckOutcome> {
    const subject = await this.subjectHash(matrixId);
    const stored = await this.store.getVerification(subject);
    if (stored?.outcome === "minor") return "minor";
    const latest = await this.store.latestVerificationSession(subject);
    if (!latest) return stored?.outcome ?? "unverified";
    const api = this.api();
    if (!api) return stored?.outcome ?? "unverified";
    const session = await api.retrieveVerificationSession(latest.sessionId, true);
    const outcome = await this.settle(subject, session);
    return outcome === "unverified" ? (stored?.outcome ?? "unverified") : outcome;
  }

  /** An identity.verification_session.* webhook (already signature-checked). */
  async applyWebhookSession(session: VerificationSession): Promise<CheckOutcome> {
    const known = await this.store.getVerificationSession(session.id);
    // Only a check this service started, for the account it was started for.
    if (!known || session.metadata?.ri_subject !== known.subject) return "unverified";
    if (session.status !== "verified") return "unverified";
    const api = this.api();
    if (!api) return "unverified";
    // The webhook body carries no date of birth: fetch it, expanded, from Stripe.
    const full = await api.retrieveVerificationSession(session.id, true);
    return this.settle(known.subject, full);
  }

  private async settle(subject: string, session: VerificationSession): Promise<CheckOutcome> {
    if (session.metadata?.ri_subject !== subject) return "unverified";
    if (session.status !== "verified") return "unverified";
    const dob = session.verified_outputs?.dob;
    if (!dob || !dob.year || !dob.month || !dob.day) {
      // Verified, but no readable date of birth: not proof of adulthood.
      logger.warn("stranger_identity_no_dob", { sessionId: session.id });
      return "unverified";
    }
    const outcome = ageOn({ year: dob.year, month: dob.month, day: dob.day }, new Date(this.now())) >= 18 ? "adult" : "minor";
    const row = await this.store.setVerification({
      subject,
      outcome,
      livemode: session.livemode,
      verifiedAt: this.now(),
      sessionId: session.id,
    });
    logger.info("stranger_identity_settled", { outcome: row.outcome, livemode: session.livemode });
    if (this.config().redact) {
      const api = this.api();
      await api?.redactVerificationSession(session.id).catch((err) => {
        logger.error("stranger_identity_redact_failed", { sessionId: session.id, error: err instanceof Error ? err.message : String(err) });
      });
    }
    return row.outcome;
  }

  /**
   * May this account enter the stranger pool (or be matched, or exchange a
   * handle) right now? Re-checked at each of those steps, not cached.
   */
  async adultForPool(matrixId: string): Promise<{ ok: boolean; reason?: PoolRefusal }> {
    try {
      if (await this.childSafety.isIdentifierBanned({ kind: "matrix", value: matrixId })) return { ok: false, reason: "banned" };
      const row = await this.store.getVerification(await this.subjectHash(matrixId));
      if (!row) return { ok: false, reason: "unverified" };
      if (row.outcome === "minor") return { ok: false, reason: "minor" };
      if (row.outcome !== "adult") return { ok: false, reason: "unverified" };
      const cfg = this.config();
      if (!row.livemode && (cfg.production || !cfg.allowTestIdentity)) return { ok: false, reason: "test_mode_verification" };
      return { ok: true };
    } catch (err) {
      // Fail closed: a database error never lets anyone into the pool.
      logger.error("stranger_pool_check_failed", { error: err instanceof Error ? err.message : String(err) });
      return { ok: false, reason: "unverified" };
    }
  }
}
