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
  it("returns flagged with the classifier's reason", async () => {
    const llm = stubLLM({ flagged: true, reason: "sexual comment directed at the child character" });
    const result = await classifyParentMessage(llm, "irrelevant content");
    expect(result).toEqual({ flagged: true, reason: "sexual comment directed at the child character" });
  });

  it("returns not flagged for ordinary content", async () => {
    const llm = stubLLM({ flagged: false, reason: "ordinary parenting conversation" });
    const result = await classifyParentMessage(llm, "How was school today?");
    expect(result.flagged).toBe(false);
  });

  it("fails open (not flagged) when the classifier call throws", async () => {
    const llm = stubLLM(() => {
      throw new Error("provider outage");
    });
    const result = await classifyParentMessage(llm, "anything");
    expect(result.flagged).toBe(false);
    expect(result.reason).toBe("moderation_check_unavailable");
  });

  it("treats a malformed response as not flagged rather than throwing", async () => {
    const llm = stubLLM({ notFlagged: "wrong shape" });
    const result = await classifyParentMessage(llm, "anything");
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
});
