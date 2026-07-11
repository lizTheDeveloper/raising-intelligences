import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createGame } from "../src/game/state-machine.js";
import { classifyParentMessage, moderateParentMessage } from "../src/safety/moderation.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import type { GameState } from "../src/types.js";

function mockOpenAiFlagged(flagged: boolean, categories: Record<string, boolean> = {}) {
  process.env.OPENAI_API_KEY = "sk-test";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ results: [{ flagged, categories: { sexual: flagged, "sexual/minors": false, ...categories } }] }),
      { status: 200 }
    )
  );
}

describe("classifyParentMessage", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("returns flagged with the OpenAI category in the reason", async () => {
    mockOpenAiFlagged(true);
    const result = await classifyParentMessage("irrelevant content");
    expect(result.flagged).toBe(true);
    expect(result.reason).toContain("openai_moderation:");
    expect(result.reason).toContain("sexual");
  });

  it("returns not flagged for ordinary content", async () => {
    mockOpenAiFlagged(false);
    const result = await classifyParentMessage("How was school today?");
    expect(result).toEqual({ flagged: false, reason: "" });
  });

  it("fails open (not flagged) when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await classifyParentMessage("anything");
    expect(result.flagged).toBe(false);
  });
});

describe("moderateParentMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function setup() {
    const repo = new InMemoryGameRepository();
    const state = createGame("Luna");
    const games = new Map<string, GameState>([[state.id, state]]);
    return { repo, state, games };
  }

  it("does nothing and returns blocked=false when the message is not flagged", async () => {
    mockOpenAiFlagged(false);
    const { repo, state, games } = setup();

    const result = await moderateParentMessage({
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
    mockOpenAiFlagged(true);
    const { repo, state, games } = setup();

    const result = await moderateParentMessage({
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
      ipAddress: "9.9.9.9",
    });
    expect(flags[0].reason).toContain("openai_moderation:");

    expect(await repo.isIpBanned("9.9.9.9")).toBe(true);
    expect(games.get(state.id)!.phase).toBe("ended");

    const persisted = await repo.loadGame(state.id);
    expect(persisted?.phase).toBe("ended");
  });

  it("still terminates the session and persists the flag when no IP is available", async () => {
    mockOpenAiFlagged(true);
    const { repo, state, games } = setup();

    const result = await moderateParentMessage({
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
    // Even an OpenAI response that would flag everything must not be consulted here.
    mockOpenAiFlagged(true);
    const { repo, games } = setup();
    const adultChatState: GameState = { ...createGame("Luna"), phase: "adult_chat" };
    games.set(adultChatState.id, adultChatState);

    const result = await moderateParentMessage({
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
