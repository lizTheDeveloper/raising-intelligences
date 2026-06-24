import { describe, it, expect, vi, afterEach } from "vitest";
import { combineTraits, generatePersonalitySeed, type OceanScores } from "../src/game/personality.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { ParentPersonality } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("combineTraits - two parents", () => {
  it("picks parent1 score when diff <= 1 and random < 0.5", () => {
    // All traits: parent1=[2,2,2,2,2] parent2=[3,3,3,3,3], diff=1 for all
    // random < 0.5 → picks parent1's value (2) for each
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    const result = combineTraits([2, 2, 2, 2, 2], [3, 3, 3, 3, 3]);
    expect(result).toEqual([2, 2, 2, 2, 2]);
  });

  it("picks parent2 score when diff <= 1 and random >= 0.5", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.7);
    const result = combineTraits([2, 2, 2, 2, 2], [3, 3, 3, 3, 3]);
    expect(result).toEqual([3, 3, 3, 3, 3]);
  });

  it("produces wild card (1-4) when diff >= 2", () => {
    // parent1=[1,1,1,1,1] parent2=[3,3,3,3,3], diff=2 for all → wild card
    // floor(0.7 * 4) + 1 = floor(2.8) + 1 = 2+1 = 3
    vi.spyOn(Math, "random").mockReturnValue(0.7);
    const result = combineTraits([1, 1, 1, 1, 1], [3, 3, 3, 3, 3]);
    expect(result).toEqual([3, 3, 3, 3, 3]);
  });

  it("produces wild card value 1 at the low end", () => {
    // floor(0.0 * 4) + 1 = 1
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    const result = combineTraits([1, 1, 1, 1, 1], [4, 4, 4, 4, 4]);
    expect(result).toEqual([1, 1, 1, 1, 1]);
  });

  it("produces wild card value 4 at the high end", () => {
    // floor(0.999 * 4) + 1 = floor(3.996) + 1 = 3+1 = 4
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const result = combineTraits([1, 1, 1, 1, 1], [4, 4, 4, 4, 4]);
    expect(result).toEqual([4, 4, 4, 4, 4]);
  });

  it("handles mixed diff=0, diff=1, and diff>=2 traits correctly", () => {
    // p1=[2,2,2,1,1], p2=[2,3,4,1,4]
    // trait0: diff=0 ≤1 → pick via random
    // trait1: diff=1 ≤1 → pick via random
    // trait2: diff=2 ≥2 → wild card
    // trait3: diff=0 ≤1 → pick via random
    // trait4: diff=3 ≥2 → wild card

    // Return values used: trait0 pick (0.3<0.5 → p1=2), trait1 pick (0.3<0.5 → p1=2),
    // trait2 wildcard (floor(0.3*4)+1 = 2), trait3 pick (0.3<0.5 → p1=1),
    // trait4 wildcard (floor(0.3*4)+1 = 2)
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    const result = combineTraits([2, 2, 2, 1, 1], [2, 3, 4, 1, 4]);
    expect(result).toEqual([2, 2, 2, 1, 2]);
  });

  it("does not mutate input arrays", () => {
    const p1: OceanScores = [1, 2, 3, 4, 2];
    const p2: OceanScores = [2, 2, 2, 2, 2];
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    combineTraits(p1, p2);
    expect(p1).toEqual([1, 2, 3, 4, 2]);
    expect(p2).toEqual([2, 2, 2, 2, 2]);
  });

  it("returns values all within 1-4 range", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = combineTraits([1, 4, 1, 4, 2], [4, 1, 4, 1, 3]);
    for (const v of result) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(4);
    }
  });
});

describe("combineTraits - single parent", () => {
  it("applies +1 to 2 distinct traits when deltas are positive", () => {
    // Fisher-Yates picks:
    // i0 = floor(0.4 * 5) = 2, swap indices[0] with indices[2] → selected index 2
    // i1 = 1 + floor(0.6 * 4) = 1+2 = 3, swap indices[1] with indices[3] → selected index 3 (of remaining)
    // delta0 = 0.9 >= 0.5 → +1
    // delta1 = 0.9 >= 0.5 → +1
    const mockRandom = vi.spyOn(Math, "random");
    mockRandom
      .mockReturnValueOnce(0.4)  // i0 = floor(0.4*5) = 2
      .mockReturnValueOnce(0.6)  // i1 = 1 + floor(0.6*4) = 3
      .mockReturnValueOnce(0.9)  // delta0 = +1
      .mockReturnValueOnce(0.9); // delta1 = +1

    // Starting: [2,2,2,2,2], trait at index 2 gets +1=3, trait at index 3 gets +1=3
    // But wait: after swapping [0,1,2,3,4]:
    //   swap 0 with i0=2 → [2,1,0,3,4]
    //   swap 1 with i1-th position from [1..4] in the new array, i1=3 means indices[3]=3
    //   → [2,3,0,1,4]
    // traits to modify are indices[0]=2 and indices[1]=3
    const result = combineTraits([2, 2, 2, 2, 2]);
    expect(result[2]).toBe(3); // trait index 2: 2+1=3
    expect(result[3]).toBe(3); // trait index 3: 2+1=3
    // unchanged traits
    expect(result[0]).toBe(2);
    expect(result[1]).toBe(2);
    expect(result[4]).toBe(2);
  });

  it("applies -1 to 2 distinct traits when deltas are negative", () => {
    const mockRandom = vi.spyOn(Math, "random");
    mockRandom
      .mockReturnValueOnce(0.0)  // i0 = 0, no swap
      .mockReturnValueOnce(0.0)  // i1 = 1 + 0 = 1, no swap
      .mockReturnValueOnce(0.2)  // delta0 < 0.5 → -1
      .mockReturnValueOnce(0.2); // delta1 < 0.5 → -1

    // traits 0 and 1 get -1
    const result = combineTraits([3, 3, 3, 3, 3]);
    expect(result[0]).toBe(2);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe(3);
    expect(result[3]).toBe(3);
    expect(result[4]).toBe(3);
  });

  it("clamps values at 1 (cannot go below 1)", () => {
    const mockRandom = vi.spyOn(Math, "random");
    mockRandom
      .mockReturnValueOnce(0.0)  // i0=0
      .mockReturnValueOnce(0.0)  // i1=1
      .mockReturnValueOnce(0.1)  // delta -1
      .mockReturnValueOnce(0.1); // delta -1

    const result = combineTraits([1, 1, 3, 3, 3]);
    expect(result[0]).toBe(1); // clamped: 1-1=0 → 1
    expect(result[1]).toBe(1); // clamped: 1-1=0 → 1
  });

  it("clamps values at 4 (cannot go above 4)", () => {
    const mockRandom = vi.spyOn(Math, "random");
    mockRandom
      .mockReturnValueOnce(0.0)  // i0=0
      .mockReturnValueOnce(0.0)  // i1=1
      .mockReturnValueOnce(0.9)  // delta +1
      .mockReturnValueOnce(0.9); // delta +1

    const result = combineTraits([4, 4, 2, 2, 2]);
    expect(result[0]).toBe(4); // clamped: 4+1=5 → 4
    expect(result[1]).toBe(4); // clamped: 4+1=5 → 4
  });

  it("modifies exactly 2 traits (the rest are unchanged copies)", () => {
    const mockRandom = vi.spyOn(Math, "random");
    mockRandom
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.2);

    const parent: OceanScores = [2, 3, 2, 3, 2];
    const result = combineTraits(parent);

    // Traits 0 and 1 are changed; 2,3,4 must match parent
    expect(result[2]).toBe(parent[2]);
    expect(result[3]).toBe(parent[3]);
    expect(result[4]).toBe(parent[4]);
  });

  it("does not mutate input array", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const parent: OceanScores = [2, 3, 1, 4, 2];
    combineTraits(parent);
    expect(parent).toEqual([2, 3, 1, 4, 2]);
  });
});

describe("generatePersonalitySeed", () => {
  it("calls the LLM with personality_seed role", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["She came into the world already restless."];

    const parent1: ParentPersonality = {
      ocean: [3, 2, 4, 2, 3],
      confessional1: "I have a terrible temper.",
      confessional2: "",
    };

    vi.spyOn(Math, "random").mockReturnValue(0.5);

    await generatePersonalitySeed(mock, "Luna", parent1);

    expect(mock.roleCalls).toContain("personality_seed");
  });

  it("returns the LLM's response as the seed", async () => {
    const mock = new MockLLMClient();
    const expected = "She came into the world already restless.";
    mock.identityUpdates = [expected];

    const parent1: ParentPersonality = {
      ocean: [3, 2, 4, 2, 3],
      confessional1: "",
      confessional2: "",
    };

    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const result = await generatePersonalitySeed(mock, "Luna", parent1);
    expect(result).toBe(expected);
  });

  it("includes childName in the system prompt (via replaceAll)", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["seed text"];

    // Spy on completeResponse to capture what was passed
    const calls: Array<[string, string]> = [];
    const origComplete = mock.completeResponse.bind(mock);
    mock.completeResponse = async (system: string, userMessage: string, ...rest: unknown[]) => {
      calls.push([system, userMessage]);
      return origComplete(system, userMessage, ...(rest as Parameters<typeof origComplete>).slice(2));
    };

    const parent1: ParentPersonality = {
      ocean: [2, 2, 2, 2, 2],
      confessional1: "",
      confessional2: "",
    };

    vi.spyOn(Math, "random").mockReturnValue(0.5);

    await generatePersonalitySeed(mock, "Mia", parent1);

    expect(calls[0][0]).toContain("Mia");
    expect(calls[0][0]).not.toContain("{childName}");
  });

  it("includes confessionals from both parents in user message", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["seed"];

    const calls: Array<[string, string]> = [];
    const origComplete = mock.completeResponse.bind(mock);
    mock.completeResponse = async (system: string, userMessage: string, ...rest: unknown[]) => {
      calls.push([system, userMessage]);
      return origComplete(system, userMessage, ...(rest as Parameters<typeof origComplete>).slice(2));
    };

    const parent1: ParentPersonality = {
      ocean: [2, 2, 2, 2, 2],
      confessional1: "I have anxiety.",
      confessional2: "I never felt good enough.",
    };
    const parent2: ParentPersonality = {
      ocean: [3, 3, 3, 3, 3],
      confessional1: "I grew up poor.",
      confessional2: "",
    };

    vi.spyOn(Math, "random").mockReturnValue(0.5);

    await generatePersonalitySeed(mock, "Max", parent1, parent2);

    expect(calls[0][1]).toContain("I have anxiety.");
    expect(calls[0][1]).toContain("I never felt good enough.");
    expect(calls[0][1]).toContain("I grew up poor.");
  });
});
