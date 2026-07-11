import { describe, it, expect } from "vitest";
import { createGame } from "../src/game/state-machine.js";
import { classifyParentMessage, moderateParentMessage } from "../src/safety/moderation.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import type { LLMClient } from "../src/llm/client.js";
import type { GameState } from "../src/types.js";

/** A minimal LLMClient stub that answers completeJson with a fixed payload
 * (or throws), so classifier tests don't depend on the shared MockLLMClient's
 * event-queue shape. */
function stubLLM(response: unknown | (() => unknown)): LLMClient {
  return {
    async streamResponse() {
      throw new Error("not used in these tests");
    },
    async completeResponse() {
      throw new Error("not used in these tests");
    },
    async completeJson<T>() {
      const value = typeof response === "function" ? (response as () => unknown)() : response;
      return value as T;
    },
  };
}

describe("classifyParentMessage", () => {
  const state = createGame("Luna");

  it("returns flagged with the classifier's reason", async () => {
    const llm = stubLLM({ flagged: true, reason: "sexual comment directed at the child character" });
    const result = await classifyParentMessage(llm, state, "irrelevant content");
    expect(result).toEqual({ flagged: true, reason: "sexual comment directed at the child character" });
  });

  it("returns not flagged for ordinary content", async () => {
    const llm = stubLLM({ flagged: false, reason: "ordinary parenting conversation" });
    const result = await classifyParentMessage(llm, state, "How was school today?");
    expect(result.flagged).toBe(false);
  });

  it("fails open (not flagged) when the classifier call throws", async () => {
    const llm = stubLLM(() => {
      throw new Error("provider outage");
    });
    const result = await classifyParentMessage(llm, state, "anything");
    expect(result.flagged).toBe(false);
    expect(result.reason).toBe("moderation_check_unavailable");
  });

  it("treats a malformed response as not flagged rather than throwing", async () => {
    const llm = stubLLM({ notFlagged: "wrong shape" });
    const result = await classifyParentMessage(llm, state, "anything");
    expect(result.flagged).toBe(false);
  });
});

describe("moderateParentMessage", () => {
  function setup() {
    const repo = new InMemoryGameRepository();
    const state = createGame("Luna");
    const games = new Map<string, GameState>([[state.id, state]]);
    return { repo, state, games };
  }

  it("does nothing and returns blocked=false when the message is not flagged", async () => {
    const { repo, state, games } = setup();
    const llm = stubLLM({ flagged: false, reason: "fine" });

    const result = await moderateParentMessage({
      llm,
      repo,
      games,
      state,
      sender: "parent1",
      content: "How was school today?",
      ipAddress: "1.2.3.4",
    });

    expect(result.blocked).toBe(false);
    expect(repo.getModerationFlags()).toEqual([]);
    expect(await repo.isIpBanned("1.2.3.4")).toBe(false);
    expect(games.get(state.id)!.phase).toBe(state.phase);
  });

  it("persists the flag, bans the IP, and terminates the session when flagged", async () => {
    const { repo, state, games } = setup();
    const llm = stubLLM({ flagged: true, reason: "sexual content directed at the child" });

    const result = await moderateParentMessage({
      llm,
      repo,
      games,
      state,
      sender: "parent1",
      content: "the flagged message text",
      ipAddress: "9.9.9.9",
    });

    expect(result.blocked).toBe(true);

    const flags = repo.getModerationFlags();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      gameId: state.id,
      sender: "parent1",
      content: "the flagged message text",
      reason: "sexual content directed at the child",
      ipAddress: "9.9.9.9",
    });

    expect(await repo.isIpBanned("9.9.9.9")).toBe(true);
    expect(games.get(state.id)!.phase).toBe("ended");

    const persisted = await repo.loadGame(state.id);
    expect(persisted?.phase).toBe("ended");
  });

  it("still terminates the session and persists the flag when no IP is available", async () => {
    const { repo, state, games } = setup();
    const llm = stubLLM({ flagged: true, reason: "flagged" });

    const result = await moderateParentMessage({
      llm,
      repo,
      games,
      state,
      sender: "parent2",
      content: "flagged text",
      ipAddress: null,
    });

    expect(result.blocked).toBe(true);
    expect(repo.getModerationFlags()).toHaveLength(1);
    expect(repo.getModerationFlags()[0].ipAddress).toBeNull();
    expect(games.get(state.id)!.phase).toBe("ended");
  });

  it("skips moderation entirely in the adult_chat phase (recipient is a 25-year-old, not a minor)", async () => {
    const { repo, games } = setup();
    const adultChatState: GameState = { ...createGame("Luna"), phase: "adult_chat" };
    games.set(adultChatState.id, adultChatState);

    // Even a classifier that would flag everything must not be consulted here.
    const llm = stubLLM({ flagged: true, reason: "would flag anything" });

    const result = await moderateParentMessage({
      llm,
      repo,
      games,
      state: adultChatState,
      sender: "parent1",
      content: "anything at all",
      ipAddress: "9.9.9.9",
    });

    expect(result.blocked).toBe(false);
    expect(repo.getModerationFlags()).toEqual([]);
    expect(await repo.isIpBanned("9.9.9.9")).toBe(false);
  });
});

describe("classifyParentMessage scene context", () => {
  it("includes the scene setup, child's age, and recent conversation in the prompt sent to the classifier", async () => {
    let capturedUserMessage = "";
    const llm: LLMClient = {
      async streamResponse() {
        throw new Error("not used");
      },
      async completeResponse() {
        throw new Error("not used");
      },
      async completeJson<T>(_system: string, userMessage: string) {
        capturedUserMessage = userMessage;
        return { flagged: false, reason: "fine" } as unknown as T;
      },
    };

    let state = createGame("Luna");
    state = {
      ...state,
      currentEventNumber: 1,
      currentEvent: { eventNumber: 1, age: 7, description: "Bedtime routine after a long day.", setting: "home", trigger: "bedtime" },
      messages: [
        { sender: "parent1", content: "Time for pajamas!", chatType: "shared", eventNumber: 1, visibleTo: ["parent1", "parent2", "kid"], timestamp: 1 },
        { sender: "kid", content: "*giggles and runs away*", chatType: "shared", eventNumber: 1, visibleTo: ["parent1", "parent2", "kid"], timestamp: 2 },
      ],
    };

    await classifyParentMessage(llm, state, "*tickle her more*");

    expect(capturedUserMessage).toContain("current age in this scene: 7");
    expect(capturedUserMessage).toContain("Bedtime routine after a long day.");
    expect(capturedUserMessage).toContain("Time for pajamas!");
    expect(capturedUserMessage).toContain("*tickle her more*");
  });
});
