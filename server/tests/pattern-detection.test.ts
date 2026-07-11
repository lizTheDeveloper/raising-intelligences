import { describe, it, expect } from "vitest";
import { createGame } from "../src/game/state-machine.js";
import { detectGroomingPattern, detectConcerningTrajectory } from "../src/safety/pattern-detection.js";
import type { LLMClient } from "../src/llm/client.js";
import type { GameState, Message } from "../src/types.js";

function stubLLM(
  response: unknown | (() => unknown),
  onCall?: (system: string, userMessage: string) => void
): LLMClient {
  return {
    async streamResponse() {
      throw new Error("not used in these tests");
    },
    async completeResponse() {
      throw new Error("not used in these tests");
    },
    async completeJson<T>(system: string, userMessage: string) {
      onCall?.(system, userMessage);
      const value = typeof response === "function" ? (response as () => unknown)() : response;
      return value as T;
    },
  };
}

function stateWithScene(messages: Message[], overrides: Partial<GameState> = {}): GameState {
  return {
    ...createGame("Luna"),
    currentEventNumber: 1,
    currentEvent: { eventNumber: 1, age: 7, description: "Bedtime routine.", setting: "home", trigger: "bedtime" },
    messages,
    ...overrides,
  };
}

const sampleMessages: Message[] = [
  { sender: "parent1", content: "Time for pajamas!", chatType: "shared", eventNumber: 1, visibleTo: ["parent1", "parent2", "kid"], timestamp: 1 },
  { sender: "kid", content: "*giggles and runs away*", chatType: "shared", eventNumber: 1, visibleTo: ["parent1", "parent2", "kid"], timestamp: 2 },
];

describe("detectGroomingPattern", () => {
  it("returns flagged with the reviewer's reason when flagged", async () => {
    const llm = stubLLM({ flagged: true, reason: "escalating secrecy pattern across the scene" });
    const result = await detectGroomingPattern(llm, stateWithScene(sampleMessages));
    expect(result).toEqual({ flagged: true, reason: "escalating secrecy pattern across the scene" });
  });

  it("returns not flagged for an ordinary scene", async () => {
    const llm = stubLLM({ flagged: false, reason: "ordinary bedtime routine" });
    const result = await detectGroomingPattern(llm, stateWithScene(sampleMessages));
    expect(result.flagged).toBe(false);
  });

  it("fails open (not flagged) when the classifier call throws", async () => {
    const llm = stubLLM(() => {
      throw new Error("provider outage");
    });
    const result = await detectGroomingPattern(llm, stateWithScene(sampleMessages));
    expect(result.flagged).toBe(false);
    expect(result.reason).toBe("grooming_pattern_check_unavailable");
  });

  it("skips the LLM call entirely when the scene has no messages yet", async () => {
    let called = false;
    const llm = stubLLM({ flagged: true, reason: "should never see this" }, () => {
      called = true;
    });
    const result = await detectGroomingPattern(llm, stateWithScene([]));
    expect(called).toBe(false);
    expect(result.flagged).toBe(false);
  });

  it("includes the current Identity Document and the full scene transcript in the prompt", async () => {
    let capturedUserMessage = "";
    const llm = stubLLM({ flagged: false, reason: "fine" }, (_system, userMessage) => {
      capturedUserMessage = userMessage;
    });

    const state = stateWithScene(sampleMessages, {
      identityDocument: "Core belief: the world is mostly safe.",
    });

    await detectGroomingPattern(llm, state);

    expect(capturedUserMessage).toContain("Core belief: the world is mostly safe.");
    expect(capturedUserMessage).toContain("Time for pajamas!");
  });
});

describe("detectConcerningTrajectory", () => {
  it("returns the guidance seed when severity is notable", async () => {
    const llm = stubLLM({ severity: "notable", guidance_seed: "Someone could gently model taking responsibility without shame." });
    const state = stateWithScene(sampleMessages, { identityDocument: "Some identity document text." });
    const result = await detectConcerningTrajectory(llm, state);
    expect(result).toEqual({
      severity: "notable",
      guidanceSeed: "Someone could gently model taking responsibility without shame.",
    });
  });

  it("returns the guidance seed when severity is significant", async () => {
    const llm = stubLLM({ severity: "significant", guidance_seed: "A gentle, specific piece of advice." });
    const state = stateWithScene(sampleMessages, { identityDocument: "Some identity document text." });
    const result = await detectConcerningTrajectory(llm, state);
    expect(result.severity).toBe("significant");
    expect(result.guidanceSeed).toBe("A gentle, specific piece of advice.");
  });

  it("suppresses the guidance seed when severity is only mild, even if the model wrote one", async () => {
    const llm = stubLLM({ severity: "mild", guidance_seed: "This should never be used." });
    const state = stateWithScene(sampleMessages, { identityDocument: "Some identity document text." });
    const result = await detectConcerningTrajectory(llm, state);
    expect(result.severity).toBe("mild");
    expect(result.guidanceSeed).toBe("");
  });

  it("suppresses the guidance seed when severity is none", async () => {
    const llm = stubLLM({ severity: "none", guidance_seed: "This should never be used either." });
    const state = stateWithScene(sampleMessages, { identityDocument: "Some identity document text." });
    const result = await detectConcerningTrajectory(llm, state);
    expect(result).toEqual({ severity: "none", guidanceSeed: "" });
  });

  it("treats an invalid severity value as none", async () => {
    const llm = stubLLM({ severity: "extremely-concerning", guidance_seed: "should be dropped" });
    const state = stateWithScene(sampleMessages, { identityDocument: "Some identity document text." });
    const result = await detectConcerningTrajectory(llm, state);
    expect(result).toEqual({ severity: "none", guidanceSeed: "" });
  });

  it("fails closed to 'none' when the classifier call throws", async () => {
    const llm = stubLLM(() => {
      throw new Error("provider outage");
    });
    const state = stateWithScene(sampleMessages, { identityDocument: "Some identity document text." });
    const result = await detectConcerningTrajectory(llm, state);
    expect(result).toEqual({ severity: "none", guidanceSeed: "" });
  });

  it("skips the LLM call entirely when there is no Identity Document yet", async () => {
    let called = false;
    const llm = stubLLM({ severity: "significant", guidance_seed: "should never see this" }, () => {
      called = true;
    });
    const state = stateWithScene(sampleMessages, { identityDocument: "" });
    const result = await detectConcerningTrajectory(llm, state);
    expect(called).toBe(false);
    expect(result).toEqual({ severity: "none", guidanceSeed: "" });
  });

  it("sends the Identity Document to the classifier", async () => {
    let capturedUserMessage = "";
    const llm = stubLLM({ severity: "none", guidance_seed: "" }, (_system, userMessage) => {
      capturedUserMessage = userMessage;
    });
    const state = stateWithScene(sampleMessages, {
      identityDocument: "Core belief: causing pain feels satisfying and fair.",
    });

    await detectConcerningTrajectory(llm, state);

    expect(capturedUserMessage).toContain("Core belief: causing pain feels satisfying and fair.");
  });
});
