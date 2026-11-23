import type { IdentityApi, VerificationSession } from "../../src/stranger/identity.js";
import type { StripeParams } from "../../src/payments/stripe.js";
import type { StrangerConfig } from "../../src/stranger/config.js";

/** In-memory Stripe Identity. `complete()` plays the part of the person holding the ID. */
export class FakeIdentity implements IdentityApi {
  sessions = new Map<string, VerificationSession & { dob?: { day: number; month: number; year: number } | null }>();
  created: StripeParams[] = [];
  redacted: string[] = [];
  livemode = true;
  private n = 0;

  async createVerificationSession(params: StripeParams): Promise<VerificationSession> {
    this.created.push(params);
    const id = `vs_fake${String(++this.n).padStart(10, "0")}`;
    const s = {
      id,
      status: "requires_input" as const,
      url: `https://verify.stripe.test/${id}`,
      livemode: this.livemode,
      metadata: { ri_subject: String(params["metadata[ri_subject]"]) },
      last_error: null,
    };
    this.sessions.set(id, s);
    return { ...s };
  }

  async retrieveVerificationSession(id: string, expandDob: boolean): Promise<VerificationSession> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const { dob, ...rest } = s;
    return { ...rest, ...(expandDob && s.status === "verified" ? { verified_outputs: { dob: dob ?? null } } : {}) };
  }

  async redactVerificationSession(id: string): Promise<void> {
    this.redacted.push(id);
  }

  /** The person completes the check with a document showing this date of birth. */
  complete(id: string, dob: { day: number; month: number; year: number } | null): void {
    const s = this.sessions.get(id)!;
    s.status = "verified";
    s.dob = dob;
  }

  fail(id: string): void {
    const s = this.sessions.get(id)!;
    s.status = "requires_input";
    s.last_error = { code: "document_unverified_other", reason: "not readable" };
  }

  last(): string {
    return [...this.sessions.keys()].at(-1)!;
  }
}

export function strangerConfig(overrides: Partial<StrangerConfig> = {}): StrangerConfig {
  return {
    mode: "meetup",
    meetupCodes: new Set(["tea-party"]),
    identityKey: "rk_live_fake_identity",
    identityWebhookSecret: "whsec_identity_fake",
    production: true,
    allowTestIdentity: false,
    redact: true,
    matrixUserinfoUrl: "https://matrix.example/_matrix/federation/v1/openid/userinfo",
    publicBaseUrl: "http://localhost:5173",
    joinWindowMs: 180_000,
    takeoverGraceMs: 90_000,
    ...overrides,
  };
}

/** A date of birth exactly `years` years before `now`, shifted by `days`. */
export function dobYearsAgo(years: number, days = 0, now = new Date()): { day: number; month: number; year: number } {
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return { day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}
