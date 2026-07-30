import { describe, it, expect } from "vitest";
import { createGame } from "../src/game/state-machine.js";
import { classifyScene, detectConcerningTrajectory } from "../src/safety/pattern-detection.js";
import { MockLLMClient } from "../src/llm/mock.js";
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

describe("classifyScene", () => {
  it("returns tier 'none' with no scene content (fails open)", async () => {
    const llm = new MockLLMClient();
    llm.groomingResult = { tier: "block", reason: "should be ignored" };
    const result = await classifyScene(llm, stateWithScene([]));
    expect(result.tier).toBe("none");
    expect(mockRoleWasNotCalled(llm)).toBe(true); // no LLM call when scene empty
  });

  it("passes through a 'block' verdict from the classifier", async () => {
    const llm = new MockLLMClient();
    llm.groomingResult = { tier: "block", reason: "sexual content directed at the child" };
    const result = await classifyScene(llm, stateWithScene(sampleMessages));
    expect(result).toEqual({ tier: "block", reason: "sexual content directed at the child" });
  });

  it("passes through a 'concern' verdict (dark parenting, no block)", async () => {
    const llm = new MockLLMClient();
    llm.groomingResult = { tier: "concern", reason: "parent facilitated the child burning a grub" };
    const result = await classifyScene(llm, stateWithScene(sampleMessages));
    expect(result.tier).toBe("concern");
  });

  it("coerces an unknown/garbled tier to 'none'", async () => {
    const llm = new MockLLMClient();
    llm.groomingResult = { tier: "banhammer" as unknown as "block", reason: "x" };
    const result = await classifyScene(llm, stateWithScene(sampleMessages));
    expect(result.tier).toBe("none");
  });

  it("fails open to 'none' when the classifier throws", async () => {
    const llm = new MockLLMClient();
    llm.throwOnSafetyCheck = true;
    const result = await classifyScene(llm, stateWithScene(sampleMessages));
    expect(result.tier).toBe("none");
    expect(result.reason).toBe("scene_safety_check_unavailable");
  });
});

function mockRoleWasNotCalled(llm: MockLLMClient): boolean {
  return !llm.roleCalls.includes("safety_check");
}

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
