import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  TracedLLMClient,
  isLangfuseEnabled,
  getLangfuseClient,
  resolveLangfuseBaseUrl,
  redactText,
  __resetLangfuseClientForTests,
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
    for (const key of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASEURL"]) {
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

// #140 — when Langfuse is configured but no baseUrl is given, the SDK's own
// default is Langfuse Cloud, which would ship parents' confessional text off
// our infrastructure with no documented retention. We must default to the
// self-hosted instance instead, and let an explicit env var still override it.
describe("resolveLangfuseBaseUrl (#140 — never silently falls back to Langfuse Cloud)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["LANGFUSE_BASEURL", "LANGFUSE_HOST"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("defaults to the self-hosted instance when neither env var is set", () => {
    const baseUrl = resolveLangfuseBaseUrl();
    expect(baseUrl).not.toBe("https://cloud.langfuse.com");
    expect(baseUrl).toContain("multiversegames.ai");
  });

  it("honors an explicit LANGFUSE_BASEURL override", () => {
    process.env.LANGFUSE_BASEURL = "https://custom.example.com";
    expect(resolveLangfuseBaseUrl()).toBe("https://custom.example.com");
  });

  it("honors LANGFUSE_HOST when LANGFUSE_BASEURL is absent", () => {
    process.env.LANGFUSE_HOST = "https://host.example.com";
    expect(resolveLangfuseBaseUrl()).toBe("https://host.example.com");
  });
});

// #140 — the personality-seed prompt embeds both parents' confessional
// free-text verbatim (game/personality.ts). Its traced input must be
// redacted to length-only; every other role's input must pass through
// unchanged so debugging value isn't lost where there's nothing sensitive.
describe("redactText (#140 — confessional-bearing prompts never reach the trace payload)", () => {
  it("redacts personality_seed input to a length marker", () => {
    const confessional = "The most evil thing I did as a kid was...";
    const redacted = redactText("personality_seed", confessional);
    expect(redacted).not.toContain("evil thing I did as a kid");
    expect(redacted).toBe(`[redacted: ${confessional.length} chars]`);
  });

  it("passes through non-confessional roles unchanged", () => {
    expect(redactText("kid", "hello there")).toBe("hello there");
    expect(redactText("world_manager", "scene description")).toBe("scene description");
    expect(redactText(undefined, "no role")).toBe("no role");
  });
});
