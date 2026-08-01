import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createGame } from "../src/game/state-machine.js";
import { classifyParentMessage, moderateParentMessage, applyModerationBlock, recordConcern, categoriesForPhase } from "../src/safety/moderation.js";
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

/** Mock a specific per-category OpenAI verdict. The phase-scoped check reads
 * individual categories, not the top-level `flagged` boolean, so which
 * categories are true is the whole point of these cases. */
function mockOpenAiCategories(categories: Record<string, boolean>) {
  process.env.OPENAI_API_KEY = "sk-test";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        results: [{ flagged: Object.values(categories).some(Boolean), categories }],
      }),
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

  // ------------------------------------------------------------ adult_chat --
  // The endgame conversation is with a 25-year-old, so the per-message check is
  // NARROWED there, not skipped. It used to return before classifyParentMessage
  // ran at all, which was harmless only while PARENT_MESSAGE was an illegal
  // transition from the phase; now that it is legal, that early return would be
  // an unmoderated LLM endpoint.
  describe("adult_chat", () => {
    function adultSetup() {
      const repo = new InMemoryGameRepository();
      const state: GameState = { ...createGame("Luna"), phase: "adult_chat" };
      const games = new Map<string, GameState>([[state.id, state]]);
      return { repo, state, games };
    }

    it("STILL blocks and bans on sexual/minors — the check is narrowed, not skipped", async () => {
      mockOpenAiCategories({ "sexual/minors": true, sexual: true });
      const { repo, state, games } = adultSetup();

      const result = await moderateParentMessage({
        repo,
        games,
        state,
        sender: "parent1",
        content: "content OpenAI flags as sexual/minors",
        ipAddress: "9.9.9.9",
      });

      expect(result.blocked).toBe(true);
      expect(repo.getModerationFlags()).toHaveLength(1);
      expect(repo.getModerationFlags()[0].reason).toContain("sexual/minors");
      // Same posture as family_chat: the per-message OpenAI check is the
      // reliable one, and it auto-bans.
      expect(await repo.isIpBanned("9.9.9.9")).toBe(true);
      expect(games.get(state.id)!.phase).toBe("ended");
    });

    it("does NOT block adult-to-adult content that is only inappropriate to a minor", async () => {
      // The design intent. OpenAI flags plain "sexual" but not "sexual/minors"
      // — e.g. a parent asking their grown child about their marriage, their
      // sexuality, or whether they're trying for a baby. Under family_chat
      // rules that is a block AND a permanent IP ban; here it must pass.
      mockOpenAiCategories({ sexual: true, "sexual/minors": false });
      const { repo, state, games } = adultSetup();

      const result = await moderateParentMessage({
        repo,
        games,
        state,
        sender: "parent1",
        content: "are you and Sam still trying for a baby?",
        ipAddress: "9.9.9.9",
      });

      expect(result.blocked).toBe(false);
      expect(repo.getModerationFlags()).toEqual([]);
      expect(await repo.isIpBanned("9.9.9.9")).toBe(false);
      expect(games.get(state.id)!.phase).toBe("adult_chat");
    });

    it("the SAME message in family_chat is blocked — the difference is the recipient", async () => {
      // Direct comparison against the case above: identical OpenAI verdict,
      // identical text, different phase. This is what makes the narrowing a
      // deliberate phase policy rather than a hole.
      mockOpenAiCategories({ sexual: true, "sexual/minors": false });
      const { repo, state, games } = setup();

      const result = await moderateParentMessage({
        repo,
        games,
        state, // createGame() starts in event_intro; any non-adult_chat phase
        sender: "parent1",
        content: "are you and Sam still trying for a baby?",
        ipAddress: "9.9.9.9",
      });

      expect(result.blocked).toBe(true);
      expect(await repo.isIpBanned("9.9.9.9")).toBe(true);
    });

    it("consults the classifier at all in adult_chat (the old early return did not)", async () => {
      mockOpenAiCategories({ sexual: false, "sexual/minors": false });
      const { repo, state, games } = adultSetup();

      await moderateParentMessage({
        repo,
        games,
        state,
        sender: "parent1",
        content: "I'm glad you called.",
        ipAddress: null,
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe("categoriesForPhase", () => {
  it("asks only about sexual/minors in adult_chat", () => {
    expect(categoriesForPhase("adult_chat")).toEqual(["sexual/minors"]);
  });

  it("asks about both categories in every other phase", () => {
    for (const phase of ["family_chat", "sidebar", "debrief", "epilogue"] as const) {
      expect(categoriesForPhase(phase)).toEqual(["sexual/minors", "sexual"]);
    }
  });
});


describe("applyModerationBlock", () => {
  function setup() {
    const repo = new InMemoryGameRepository();
    const state = createGame("Luna");
    const games = new Map<string, GameState>([[state.id, state]]);
    return { repo, state, games };
  }

  it("bans the IP by default (per-message caller behavior)", async () => {
    const { repo, state, games } = setup();

    await applyModerationBlock({
      repo,
      games,
      state,
      sender: "parent1",
      content: "flagged content",
      reason: "test reason",
      ipAddress: "5.5.5.5",
    });

    expect(await repo.isIpBanned("5.5.5.5")).toBe(true);
    expect(games.get(state.id)!.phase).toBe("ended");
    expect(repo.getModerationFlags()).toHaveLength(1);
  });

  it("does NOT ban the IP when banIp is false (scene-level grooming-pattern caller) but still flags and ends the session", async () => {
    const { repo, state, games } = setup();

    await applyModerationBlock({
      repo,
      games,
      state,
      sender: "parent1",
      content: "a whole scene transcript",
      reason: "grooming-pattern reason",
      ipAddress: "8.8.8.8",
      banIp: false,
    });

    expect(await repo.isIpBanned("8.8.8.8")).toBe(false);
    expect(games.get(state.id)!.phase).toBe("ended");
    const flags = repo.getModerationFlags();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ ipAddress: "8.8.8.8", reason: "grooming-pattern reason" });
  });

  it("repeat-offender: a FIRST flag for this IP ends the session but does NOT ban", async () => {
    const { repo, state, games } = setup();

    await applyModerationBlock({
      repo,
      games,
      state,
      sender: "parent1",
      content: "a whole scene transcript",
      reason: "verbal-abuse pattern",
      ipAddress: "4.4.4.4",
      banIp: "repeat-offender",
    });

    expect(await repo.isIpBanned("4.4.4.4")).toBe(false);
    expect(games.get(state.id)!.phase).toBe("ended");
    expect(repo.getModerationFlags()).toHaveLength(1);
  });

  it("repeat-offender: a SECOND flag in a DIFFERENT game permanently bans the IP", async () => {
    const { repo, state, games } = setup();
    // A prior flag for the same IP in another game/session.
    await repo.saveModerationFlag({
      gameId: "an-earlier-game",
      sender: "parent1",
      content: "earlier scene",
      reason: "verbal-abuse pattern",
      ipAddress: "4.4.4.4",
    });

    await applyModerationBlock({
      repo,
      games,
      state,
      sender: "parent1",
      content: "a whole scene transcript",
      reason: "verbal-abuse pattern",
      ipAddress: "4.4.4.4",
      banIp: "repeat-offender",
    });

    expect(await repo.isIpBanned("4.4.4.4")).toBe(true);
    expect(games.get(state.id)!.phase).toBe("ended");
  });

  it("repeat-offender: multiple flags within the SAME game do not count as repeat (no ban)", async () => {
    const { repo, state, games } = setup();
    // An earlier flag in THIS same game.
    await repo.saveModerationFlag({
      gameId: state.id,
      sender: "parent1",
      content: "earlier scene, same game",
      reason: "verbal-abuse pattern",
      ipAddress: "4.4.4.4",
    });

    await applyModerationBlock({
      repo,
      games,
      state,
      sender: "parent1",
      content: "a later scene, same game",
      reason: "verbal-abuse pattern",
      ipAddress: "4.4.4.4",
      banIp: "repeat-offender",
    });

    expect(await repo.isIpBanned("4.4.4.4")).toBe(false);
  });

  it("repeat-offender with no IP available: ends the session, never bans", async () => {
    const { repo, state, games } = setup();

    await applyModerationBlock({
      repo,
      games,
      state,
      sender: "parent1",
      content: "a whole scene transcript",
      reason: "verbal-abuse pattern",
      ipAddress: null,
      banIp: "repeat-offender",
    });

    expect(games.get(state.id)!.phase).toBe("ended");
    expect(repo.getModerationFlags()).toHaveLength(1);
  });
});

describe("recordConcern", () => {
  it("persists a concern event and does NOT end the session or ban", async () => {
    const repo = new InMemoryGameRepository();
    const games = new Map();
    const state = createGame("Kai");
    games.set(state.id, state);

    await recordConcern({ repo, state, sender: "parent1", reason: "facilitated cruelty", ipAddress: "9.9.9.9" });

    const events = await repo.loadConcernEvents(state.id);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("facilitated cruelty");
    // session untouched:
    expect(games.get(state.id)!.phase).not.toBe("ended");
    // IP not banned:
    expect(await repo.isIpBanned("9.9.9.9")).toBe(false);
  });
});
