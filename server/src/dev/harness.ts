import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { IdentityApi, VerificationSession } from "../stranger/identity.js";
import type { StripeParams } from "../payments/stripe.js";
import { MockLLMClient } from "../llm/mock.js";
import type { GameEvent } from "../types.js";

/**
 * Local test harness for stranger mode and host tools (docs/host-tools-test-harness.md).
 * Never in production: with NODE_ENV=production every flag here is refused,
 * loudly, and nothing is faked.
 *
 *   RI_DEV_FAKE_MATRIX=true    an OpenID token "dev:@name:local" signs in as @name:local
 *   RI_DEV_FAKE_IDENTITY=true  Stripe Identity is skipped: every check passes as an adult
 *                              (test mode, so it also needs RI_STRANGER_ALLOW_TEST_IDENTITY=true,
 *                              which production forces off anyway)
 *   RI_DEV_MOCK_LLM=true       no model calls at all: canned scenes, replies and endings
 */
export interface DevHarness {
  fakeMatrix: boolean;
  fakeIdentity: boolean;
  mockLlm: boolean;
}

export function readDevHarness(env: NodeJS.ProcessEnv = process.env): DevHarness {
  const fakeMatrix = env.RI_DEV_FAKE_MATRIX === "true";
  const fakeIdentity = env.RI_DEV_FAKE_IDENTITY === "true";
  const mockLlm = env.RI_DEV_MOCK_LLM === "true";
  if (env.NODE_ENV === "production") {
    if (fakeMatrix || fakeIdentity || mockLlm) logger.error("dev_harness_refused_in_production", { fakeMatrix, fakeIdentity, mockLlm });
    return { fakeMatrix: false, fakeIdentity: false, mockLlm: false };
  }
  if (fakeMatrix || fakeIdentity || mockLlm) logger.warn("dev_harness_on", { fakeMatrix, fakeIdentity, mockLlm });
  return { fakeMatrix, fakeIdentity, mockLlm };
}

/** A canned model for driving games locally for nothing: an endless supply of scenes. */
export function devMockLlm(): MockLLMClient {
  const mock = new MockLLMClient();
  mock.kidResponses = ["okay.", "why though?", "I didn't do it.", "can we go to the park?"];
  mock.reportCardText = [
    "# Report card",
    "## Pivotal Moments",
    "They talked it through at the kitchen table.",
    "## The Voices in Their Head",
    "### Parent 1",
    "Steady, mostly.",
    "### Parent 2",
    "Funny when it counted.",
    "## Notable Quotes That Stuck",
    "\"we'll figure it out.\"",
  ].join("\n");
  const scenes: GameEvent[] = [];
  for (let i = 0; i < 2000; i++) {
    const age = (i % 13) * 2;
    scenes.push({ eventNumber: (i % 13) + 1, age, description: `A scene at age ${age}.`, setting: "Home", trigger: "Everyday life" });
  }
  // completeJson shifts one scene per call; refill so a long session never runs dry.
  mock.events = new Proxy(scenes, {
    get(target, prop, recv) {
      if (prop === "shift") return () => { const s = target.shift()!; target.push(s); return s; };
      return Reflect.get(target, prop, recv);
    },
  });
  return mock;
}

const DEV_TOKEN = /^dev:(@[a-z0-9._=-]+:[a-z0-9.-]+)$/;

/** Wraps a real Matrix verifier: "dev:@x:local" tokens sign in as @x:local, the rest go to the real one. */
export function devMatrixVerifier(
  real: (t: unknown) => Promise<string | null>,
  harness: DevHarness,
): (t: unknown) => Promise<string | null> {
  if (!harness.fakeMatrix) return real;
  return async (t) => {
    if (typeof t === "string") {
      const m = DEV_TOKEN.exec(t);
      if (m) return m[1];
    }
    return real(t);
  };
}

/**
 * Stripe Identity, faked: the "check" sends the browser straight back to the
 * return URL, verified, born 1 January 1990, one made-up document per account.
 * Test mode (livemode false), so production could never accept it.
 */
export class DevIdentity implements IdentityApi {
  private sessions = new Map<string, VerificationSession>();

  async createVerificationSession(params: StripeParams): Promise<VerificationSession> {
    // Random, not a counter: a counter restarts with the process and collides with sessions a persistent database already holds.
    const id = `vs_dev_${randomUUID().replace(/-/g, "")}`;
    const s: VerificationSession = {
      id,
      status: "verified",
      url: String(params.return_url),
      livemode: false,
      metadata: { ri_subject: String(params["metadata[ri_subject]"]) },
      last_error: null,
    };
    this.sessions.set(id, s);
    return { ...s };
  }

  async retrieveVerificationSession(id: string, expandDob: boolean): Promise<VerificationSession> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    if (!expandDob) return { ...s };
    return {
      ...s,
      verified_outputs: { dob: { day: 1, month: 1, year: 1990 } },
      last_verification_report: { document: { number: `DEV-${s.metadata?.ri_subject ?? id}`, issuing_country: "US" } },
    };
  }

  async redactVerificationSession(): Promise<void> {}
}
