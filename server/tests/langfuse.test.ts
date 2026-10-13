import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  TracedLLMClient,
  isLangfuseEnabled,
  getLangfuseClient,
  __resetLangfuseClientForTests,
  __redactConfessionalTextForTests,
} from "../src/observability/langfuse.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { GameEvent } from "../src/types.js";

const testEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

describe("TracedLLMClient (Langfuse unconfigured)", () => {
  // Ensure Langfuse env is unset for these tests so tracing is a no-op and no
  // network calls are made.
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASEURL", "LANGFUSE_HOST"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    __resetLangfuseClientForTests();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetLangfuseClientForTests();
  });

  it("reports Langfuse as disabled and never constructs a client", () => {
    expect(isLangfuseEnabled()).toBe(false);
    expect(getLangfuseClient()).toBeNull();
  });

  it("stays disabled when keys are set but no baseUrl/host is configured (issue #140)", () => {
    // Regression guard: the Langfuse SDK defaults to Langfuse Cloud when no
    // baseUrl is given. Keys-without-host must NOT activate tracing, or
    // confessional-derived prompts would leave our infrastructure by default.
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    __resetLangfuseClientForTests();

    expect(isLangfuseEnabled()).toBe(false);
    expect(getLangfuseClient()).toBeNull();
  });

  it("activates only once a host is also configured", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_HOST = "https://langfuse.example.internal";
    __resetLangfuseClientForTests();

    expect(isLangfuseEnabled()).toBe(true);
    expect(getLangfuseClient()).not.toBeNull();
  });

  it("streamResponse passes through results and forwards chunks identically", async () => {
    const mock = new MockLLMClient();
    mock.kidResponses = ["I'm sorry!"];
    const traced = new TracedLLMClient(mock);

    const tracedChunks: string[] = [];
    const tracedResult = await traced.streamResponse(
      "system prompt",
      [{ role: "user", content: "What happened?" }],
      (c) => tracedChunks.push(c)
    );

    // Compare against the raw mock to confirm identical behavior.
    const bare = new MockLLMClient();
    bare.kidResponses = ["I'm sorry!"];
    const bareChunks: string[] = [];
    const bareResult = await bare.streamResponse(
      "system prompt",
      [{ role: "user", content: "What happened?" }],
      (c) => bareChunks.push(c)
    );

    expect(tracedResult).toBe(bareResult);
    expect(tracedResult).toBe("I'm sorry!");
    expect(tracedChunks).toEqual(bareChunks);
    expect(tracedChunks.join("")).toBe("I'm sorry!");
  });

  it("completeResponse passes through to the wrapped client", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["Core beliefs: accidents are forgivable."];
    const traced = new TracedLLMClient(mock);

    const result = await traced.completeResponse("sys", "user message");
    expect(result).toBe("Core beliefs: accidents are forgivable.");
  });

  it("completeJson passes through to the wrapped client", async () => {
    const mock = new MockLLMClient();
    mock.events = [testEvent];
    const traced = new TracedLLMClient(mock);

    const result = await traced.completeJson<GameEvent>("sys", "user message");
    expect(result).toEqual(testEvent);
  });

  it("propagates errors from the wrapped client", async () => {
    const mock = new MockLLMClient();
    mock.events = []; // completeJson throws when no events queued
    const traced = new TracedLLMClient(mock);

    await expect(traced.completeJson("sys", "user")).rejects.toThrow("No mock events available");
  });

  it("withContext returns a working client carrying metadata", async () => {
    const mock = new MockLLMClient();
    mock.kidResponses = ["okay"];
    mock.events = [testEvent];

    const traced = new TracedLLMClient(mock).withContext({
      gameId: "game-123",
      eventNumber: 2,
      role: "kid",
    });

    // It is a distinct, still-functional client.
    expect(traced).toBeInstanceOf(TracedLLMClient);

    const chunks: string[] = [];
    const streamResult = await traced.streamResponse(
      "sys",
      [{ role: "user", content: "hi" }],
      (c) => chunks.push(c)
    );
    expect(streamResult).toBe("okay");
    expect(chunks.join("")).toBe("okay");

    const jsonResult = await traced.completeJson<GameEvent>("sys", "user");
    expect(jsonResult).toEqual(testEvent);
  });

  it("withContext merges metadata without mutating the original", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["doc"];
    const base = new TracedLLMClient(mock, { gameId: "g1" });
    const derived = base.withContext({ role: "psychologist", eventNumber: 3 });

    // Both still work as transparent pass-throughs.
    expect(await base.completeResponse("s", "u")).toBe("doc");

    const mock2 = new MockLLMClient();
    mock2.identityUpdates = ["doc2"];
    const derived2 = new TracedLLMClient(mock2).withContext({ role: "kid" });
    expect(await derived2.completeResponse("s", "u")).toBe("doc2");

    expect(derived).not.toBe(base);
  });
});

describe("redactConfessionalText (issue #140)", () => {
  it("replaces a confessional quote with a length-only placeholder", () => {
    const confession = "I once stole from my sister and never told anyone.";
    const input = `Parent 1: "${confession}"`;
    const redacted = __redactConfessionalTextForTests(input);

    expect(redacted).toBe(`Parent 1: "[redacted, ${confession.length} chars]"`);
    expect(redacted).not.toContain("stole");
  });

  it("redacts every confessional span in a multi-parent prompt", () => {
    const input = [
      'Parent 1: "secret one"',
      'Parent 1: "secret two"',
      'Parent 2: "secret three"',
    ].join("\n");

    const redacted = __redactConfessionalTextForTests(input);

    expect(redacted).not.toContain("secret");
    expect(redacted.match(/\[redacted, \d+ chars\]/g)).toHaveLength(3);
    // Parent labels are preserved so the trace still shows prompt shape.
    expect(redacted).toContain('Parent 1: "[redacted,');
    expect(redacted).toContain('Parent 2: "[redacted,');
  });

  it("leaves text with no confessional spans untouched", () => {
    const input = "Child: Luna\nOCEAN scores: Openness: 3/4, Conscientiousness: 2/4";
    expect(__redactConfessionalTextForTests(input)).toBe(input);
  });
});
