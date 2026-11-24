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

/**
 * RI_DEV_TRACE_FILE=<path>: with no Langfuse configured, every trace the app
 * would send (tags, metadata, the redacted prompt) is appended to <path> as
 * JSON lines instead, so the harness can check trace tags offline. The
 * canned model goes through the same tracer as the real one (index.ts).
 * Refused in production, like the other dev flags.
 */
export function devTraceFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.RI_DEV_TRACE_FILE?.trim();
  if (!file) return null;
  if (env.NODE_ENV === "production") {
    logger.error("dev_harness_refused_in_production", { traceFile: true });
    return null;
  }
  logger.warn("dev_trace_file_on", { file });
  return file;
}

/** A canned model for driving games locally for nothing: an endless supply of scenes. */
export function devMockLlm(): MockLLMClient {
  const mock = new MockLLMClient();
  mock.kidResponses = ["okay.", "why though?", "I didn't do it.", "can we go to the park?"];
  mock.reportCardText = [
    "# Report card",
    "## Personality",
    "Curious and a little stubborn. Slow to warm up, then loyal for good.",
    "## Strengths",
    "- Keeps going when things get hard.",
    "## Struggles",
    "- Finds it hard to ask for help.",
    "## Pivotal Moments",
    "They talked it through at the kitchen table, more than once, and nobody stormed off for good.",
    "A bad winter at school turned into a long spring of walks after dinner.",
    "By sixteen the arguments were about curfews and music, which felt like a kind of peace.",
    "## The Voices in Their Head",
    "### Parent 1",
    "Steady, mostly.",
    "### Parent 2",
    "Funny when it counted.",
    "## Notable Quotes That Stuck",
    "\"we'll figure it out.\"",
    "## Where They Landed",
    "At twenty-five they keep a small garden and call home on Sundays.",
  ].join("\n");
  mock.identityUpdates = ["Core beliefs: the world is mostly safe; grown-ups can be asked things.", "Core beliefs: being wrong out loud is survivable."];
  const epilogue = "At twenty-five they live near the water and work odd, satisfying hours. They still burn the toast. Most Sundays they call home, and the calls run long.";
  // The endgame roles get their own text, as a real model's would differ from the psychologist's notes.
  const complete = mock.completeResponse.bind(mock);
  mock.completeResponse = async (system, user, maxTokens, role, onChunk) => {
    const text = role === "epilogue" ? epilogue : role === "report_card" ? mock.reportCardText : null;
    if (text === null) return complete(system, user, maxTokens, role, onChunk);
    for (const ch of text) onChunk?.(ch);
    return text;
  };
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
