import { createHmac, randomBytes } from "node:crypto";
import { pepperProblem } from "./config.js";
import { PASS_TTL_MS } from "./matrix-identity.js";
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
 * keep ONLY the outcome. Then we ask Stripe to redact the Identity session
 * (RI_IDENTITY_REDACT, on by default). Stripe redacts asynchronously (it can
 * take days) and may keep some records where the law requires.
 *
 * One document verifies one account: a keyed hash of the document's number
 * is bound to the first account it passed for, so one adult's ID can't vouch
 * for a string of other accounts.
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

/**
 * Age is computed on a clock 14 hours behind UTC. The UTC date can run ahead
 * of a player's local date (time zones run up to 12 hours behind it), so a
 * plain UTC birthday would admit some 17-year-olds on the eve of their 18th.
 * Lagging by 14h means the birthday has started in every time zone on Earth.
 */
export const AGE_CLOCK_LAG_MS = 14 * 60 * 60 * 1000;

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
  /** Non-null once Stripe has redacted (or is redacting) the session: its outputs are placeholders then. */
  redaction?: { status?: string } | null;
  /** Expanded: the report's document, for its number (one document, one account). */
  last_verification_report?: string | { document?: { number?: string | null; issuing_country?: string | null } | null } | null;
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
        expandDob ? { "expand[0]": "verified_outputs.dob", "expand[1]": "last_verification_report.document.number" } : {},
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
  /** HMAC key for subject and document hashes: RI_STRANGER_PEPPER, 32+ bytes. No fallback. */
  pepper: string;
}

export class AgeVerification {
  private readonly store: StrangerStore;
  private readonly config: () => StrangerConfig;
  private readonly childSafety: ChildSafetyStore;
  private readonly injectedApi?: IdentityApi;
  private readonly now: () => number;
  private readonly pepper: string;
  /**
   * Opaque return references (privacy review F5): Stripe's return_url used to
   * carry `?meetup=<code>`, so Stripe held "this verified person tried to
   * attend <code>". It now carries a random reference that only this process
   * resolves back to the code, for as long as a pass lives. In memory, like
   * the passes: a restart means signing in again anyway.
   */
  private readonly returnRefs = new Map<string, { meetupCode: string; expiresAt: number }>();

  constructor(deps: Deps) {
    this.store = deps.store;
    this.config = deps.config;
    this.childSafety = deps.childSafety;
    this.injectedApi = deps.api;
    this.now = deps.now ?? Date.now;
    this.pepper = deps.pepper;
  }

  /** The opaque per-account id used in every stranger record and sent to Stripe. */
  async subjectHash(matrixId: string): Promise<string> {
    return this.hmac(`subject:${matrixId}`);
  }

  private hmac(value: string): string {
    // Fail closed: never hash with a missing or guessable key.
    if (pepperProblem(this.pepper)) throw new Error("RI_STRANGER_PEPPER is missing or too short");
    return createHmac("sha256", this.pepper).update(value).digest("hex");
  }

  private issueReturnRef(meetupCode: string): string {
    const now = this.now();
    for (const [r, v] of this.returnRefs) if (v.expiresAt <= now) this.returnRefs.delete(r);
    const ref = randomBytes(18).toString("base64url");
    this.returnRefs.set(ref, { meetupCode, expiresAt: now + PASS_TTL_MS });
    if (this.returnRefs.size > 10_000) this.returnRefs.delete(this.returnRefs.keys().next().value as string);
    return ref;
  }

  /** The meetup code an ID-check return reference stands for, or null. */
  meetupForReturnRef(ref: unknown): string | null {
    if (typeof ref !== "string" || ref.length === 0 || ref.length > 64) return null;
    const v = this.returnRefs.get(ref);
    if (!v) return null;
    if (v.expiresAt <= this.now()) {
      this.returnRefs.delete(ref);
      return null;
    }
    return v.meetupCode;
  }

  /** Is this address under a child-safety ban? */
  async ipBanned(ip: string): Promise<boolean> {
    try {
      return await this.childSafety.isIdentifierBanned({ kind: "ip", value: ip });
    } catch {
      return true; // fail closed
    }
  }

  private api(): IdentityApi | null {
    if (this.injectedApi) return this.injectedApi;
    const key = this.config().identityKey;
    // Restricted keys only: reading the date of birth needs a restricted key
    // with Identity "Verification Results" and "Recent Detailed Verification
    // Results" set to Read; a plain secret key can't, so it would never admit anyone.
    if (!key || !/^rk_(live|test)_/.test(key)) return null;
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
    // Each check costs money: take one of today's slots atomically BEFORE
    // calling Stripe, so parallel requests can't all slip under the cap.
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const attempt = await this.store.reserveCheckSlot(subject, day, MAX_CHECKS_PER_DAY);
    if (attempt === null) {
      return { error: "That's the most checks for one day. Try again tomorrow.", reason: "rate_limited" };
    }
    const base = this.config().publicBaseUrl;
    // No meetup code leaves for Stripe: an opaque reference brings the player back to it.
    const returnUrl = `${base}/?stranger=identity${meetupCode ? `&ref=${this.issueReturnRef(meetupCode)}` : ""}`;
    // Only an opaque hash goes to Stripe: no Matrix id, no name, no email.
    const session = await api.createVerificationSession({
      type: "document",
      "options[document][require_matching_selfie]": true,
      "options[document][require_live_capture]": true,
      "metadata[ri_purpose]": "ri_stranger_age",
      "metadata[ri_subject]": subject,
      return_url: returnUrl,
    }, `ri-age-${subject.slice(0, 32)}-${day}-${attempt}`);
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
    // A redacted session's outputs are placeholders (a 1/1/1 birth date).
    if (session.redaction) return "unverified";
    const dob = session.verified_outputs?.dob;
    if (!dob || !dob.year || !dob.month || !dob.day || dob.year < 1900) {
      // Verified, but no plausible date of birth: not proof of adulthood.
      logger.warn("stranger_identity_no_dob", { sessionId: session.id });
      return "unverified";
    }
    // One document, one account.
    const report = typeof session.last_verification_report === "object" ? session.last_verification_report : null;
    const number = report?.document?.number?.trim();
    if (!number) {
      logger.warn("stranger_identity_no_document_number", { sessionId: session.id });
      return "unverified";
    }
    const docHash = this.hmac(`document:${(report?.document?.issuing_country ?? "").toUpperCase()}:${number.toUpperCase()}`);
    if (!(await this.store.bindDocument(docHash, subject, this.now()))) {
      logger.warn("stranger_identity_document_reused", { sessionId: session.id });
      return "unverified";
    }
    // Conservative across time zones: measured on a clock behind even the
    // furthest-behind zone (UTC-12), so the 18th birthday has begun everywhere.
    const outcome = ageOn({ year: dob.year, month: dob.month, day: dob.day }, new Date(this.now() - AGE_CLOCK_LAG_MS)) >= 18 ? "adult" : "minor";
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
  /**
   * The adult check by subject alone, for when the Matrix id isn't in memory
   * (after a restart): the stored outcome, its mode, and the ban list. The
   * ban list is keyed by Matrix id, so each banned id is hashed and compared.
   * Anything that can't be read fails closed (false).
   */
  async adultBySubject(subject: string): Promise<boolean> {
    try {
      if (await this.subjectBanned(subject)) return false;
      const row = await this.store.getVerification(subject);
      if (!row || row.outcome !== "adult") return false;
      const cfg = this.config();
      return row.livemode || (!cfg.production && cfg.allowTestIdentity);
    } catch (err) {
      logger.error("stranger_subject_check_failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Is any banned Matrix id this subject? Throws if the list can't be read (callers fail closed). */
  async subjectBanned(subject: string): Promise<boolean> {
    for (const mxid of await this.childSafety.bannedValues("matrix")) {
      if ((await this.subjectHash(mxid)) === subject) return true;
    }
    return false;
  }

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
