// Dark Play Plan 4 — escalation detection tests.
//
// isEscalation is the safety-critical predicate: it must require an
// ordinary-play denominator and must NEVER fire on a raw count of
// dark/flagged games alone. These tests exercise that property hard,
// including the "one ordinary game exonerates" case explicitly called out
// as CRITICAL in the plan.
import { describe, it, expect } from "vitest";
import {
  isEscalation,
  evaluateEscalation,
  ESCALATION_MIN_GAMES,
  ESCALATION_DARK_CONCERN,
} from "../src/safety/escalation.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";
import type { GameState } from "../src/types.js";

describe("isEscalation — pure predicate", () => {
  it("below ESCALATION_MIN_GAMES never fires, even if every game is dark", () => {
    expect(
      isEscalation({
        totalGames: ESCALATION_MIN_GAMES - 1,
        darkGames: ESCALATION_MIN_GAMES - 1,
        ordinaryGames: 0,
      })
    ).toBe(false);
  });

  it("any ordinaryGames > 0 exonerates the IP, regardless of dark count or total", () => {
    // Otherwise all-dark, at/above the threshold — would fire but for the
    // single ordinary game.
    expect(
      isEscalation({
        totalGames: ESCALATION_MIN_GAMES,
        darkGames: ESCALATION_MIN_GAMES - 1,
        ordinaryGames: 1,
      })
    ).toBe(false);

    // Even with only ONE ordinary game out of many, many dark ones.
    expect(
      isEscalation({
        totalGames: 100,
        darkGames: 99,
        ordinaryGames: 1,
      })
    ).toBe(false);
  });

  it("all-dark, no-range, at the threshold fires true", () => {
    expect(
      isEscalation({
        totalGames: ESCALATION_MIN_GAMES,
        darkGames: ESCALATION_MIN_GAMES,
        ordinaryGames: 0,
      })
    ).toBe(true);
  });

  it("all-dark, no-range, above the threshold fires true", () => {
    expect(
      isEscalation({
        totalGames: ESCALATION_MIN_GAMES + 20,
        darkGames: ESCALATION_MIN_GAMES + 20,
        ordinaryGames: 0,
      })
    ).toBe(true);
  });

  it("mixed (some dark, some neither dark nor ordinary) does not fire — darkGames must equal totalGames", () => {
    expect(
      isEscalation({
        totalGames: ESCALATION_MIN_GAMES,
        darkGames: ESCALATION_MIN_GAMES - 1,
        ordinaryGames: 0,
      })
    ).toBe(false);
  });

  it("a raw dark count alone (no denominator fields distinguishing range) cannot pass without ordinaryGames === 0 AND darkGames === totalGames both holding", () => {
    // darkGames alone being huge is not sufficient if ordinaryGames > 0.
    expect(
      isEscalation({ totalGames: 50, darkGames: 50, ordinaryGames: 5 })
    ).toBe(false);
    // darkGames alone being huge is not sufficient if darkGames < totalGames.
    expect(
      isEscalation({ totalGames: 50, darkGames: 45, ordinaryGames: 0 })
    ).toBe(false);
  });

  it("zero games never fires", () => {
    expect(isEscalation({ totalGames: 0, darkGames: 0, ordinaryGames: 0 })).toBe(false);
  });
});

/** Build a valid GameState with the fields getIpPlayProfile reads, overridden per test. */
function gameRow(
  id: string,
  overrides: Partial<
    Pick<GameState, "phase" | "concernLevel" | "highestRungFired" | "cpsOutcome" | "currentEventNumber">
  >
): GameState {
  return {
    ...createGame("Kid"),
    id,
    phase: "family_chat",
    concernLevel: 0,
    highestRungFired: 0,
    cpsOutcome: null,
    currentEventNumber: 1,
    ...overrides,
  };
}

const DARK_GAME = { phase: "family_chat" as const, concernLevel: ESCALATION_DARK_CONCERN, highestRungFired: 0, currentEventNumber: 1 };
const ORDINARY_ENDING_GAME = { phase: "epilogue" as const, concernLevel: 0, highestRungFired: 0, cpsOutcome: null, currentEventNumber: 5 };
const ORDINARY_LOW_CONCERN_GAME = { phase: "family_chat" as const, concernLevel: 0, highestRungFired: 0, currentEventNumber: 3 };
const REMOVAL_GAME = { phase: "epilogue" as const, concernLevel: ESCALATION_DARK_CONCERN, highestRungFired: 3, cpsOutcome: "removal" as const, currentEventNumber: 5 };
const NEITHER_GAME = { phase: "family_chat" as const, concernLevel: 1, highestRungFired: 0, currentEventNumber: 1 }; // abandoned at event 1 — not dark, not ordinary

describe("recordGameIp — Task 1", () => {
  it("recordGameIp on a freshly created game is reflected by getIpPlayProfile", async () => {
    const repo = new InMemoryGameRepository();
    const ip = "203.0.113.10";
    const g = gameRow("g1", DARK_GAME);
    await repo.saveGame(g);
    await repo.recordGameIp(g.id, ip);

    const profile = await repo.getIpPlayProfile(ip);
    expect(profile.totalGames).toBe(1);
  });

  it("a later saveGame checkpoint (normal game-flow persistence) does not erase the recorded IP", async () => {
    const repo = new InMemoryGameRepository();
    const ip = "203.0.113.11";
    const g = gameRow("g1", DARK_GAME);
    await repo.saveGame(g);
    await repo.recordGameIp(g.id, ip);

    // Simulate the game progressing and being re-saved, as every other route
    // handler does on nearly every request.
    await repo.saveGame({ ...g, currentEventNumber: 2 });

    const profile = await repo.getIpPlayProfile(ip);
    expect(profile.totalGames).toBe(1);
  });
});

describe("getIpPlayProfile — in-memory repo integration", () => {
  it("counts totalGames/darkGames/ordinaryGames correctly across a spread of games for one IP", async () => {
    const repo = new InMemoryGameRepository();
    const ip = "203.0.113.5";

    const dark1 = gameRow("g1", DARK_GAME);
    const dark2 = gameRow("g2", { ...DARK_GAME, highestRungFired: 1, concernLevel: 0 });
    const ordinary1 = gameRow("g3", ORDINARY_ENDING_GAME);
    const ordinary2 = gameRow("g4", ORDINARY_LOW_CONCERN_GAME);
    const removal = gameRow("g5", REMOVAL_GAME); // dark (rung fired), NOT ordinary (removal excluded)
    const neither = gameRow("g6", NEITHER_GAME);

    for (const g of [dark1, dark2, ordinary1, ordinary2, removal, neither]) {
      await repo.saveGame(g);
      await repo.recordGameIp(g.id, ip);
    }

    const profile = await repo.getIpPlayProfile(ip);
    expect(profile.totalGames).toBe(6);
    expect(profile.darkGames).toBe(3); // dark1, dark2, removal
    expect(profile.ordinaryGames).toBe(2); // ordinary1, ordinary2
  });

  it("only counts games recorded against this IP, ignoring other IPs and un-attributed (null) games", async () => {
    const repo = new InMemoryGameRepository();
    const ip = "198.51.100.9";
    const otherIp = "198.51.100.10";

    const mine = gameRow("g1", DARK_GAME);
    const theirs = gameRow("g2", DARK_GAME);
    const noIp = gameRow("g3", DARK_GAME);

    await repo.saveGame(mine);
    await repo.recordGameIp(mine.id, ip);
    await repo.saveGame(theirs);
    await repo.recordGameIp(theirs.id, otherIp);
    await repo.saveGame(noIp);
    // noIp: recordGameIp never called — historical/pre-migration shape.

    const profile = await repo.getIpPlayProfile(ip);
    expect(profile.totalGames).toBe(1);
    expect(profile.darkGames).toBe(1);
  });

  it("an IP with no games at all returns all zeros", async () => {
    const repo = new InMemoryGameRepository();
    const profile = await repo.getIpPlayProfile("203.0.113.99");
    expect(profile).toEqual({ totalGames: 0, darkGames: 0, ordinaryGames: 0 });
  });
});

describe("evaluateEscalation — flag-for-review only, deduped, exonerated by range", () => {
  async function seedGames(repo: InMemoryGameRepository, ip: string, rows: GameState[]) {
    for (const g of rows) {
      await repo.saveGame(g);
      await repo.recordGameIp(g.id, ip);
    }
  }

  it("5 all-dark, no-range games trips the flag exactly once, even across repeated calls", async () => {
    const repo = new InMemoryGameRepository();
    const ip = "192.0.2.50";
    const rows = Array.from({ length: ESCALATION_MIN_GAMES }, (_, i) => gameRow(`dark-${i}`, DARK_GAME));
    await seedGames(repo, ip, rows);

    await evaluateEscalation({ repo, ip, gameId: rows[rows.length - 1]!.id });
    expect(repo.getEscalationFlags()).toHaveLength(1);
    const flag = repo.getEscalationFlags()[0]!;
    expect(flag.ipAddress).toBe(ip);
    expect(flag.totalGames).toBe(ESCALATION_MIN_GAMES);
    expect(flag.darkGames).toBe(ESCALATION_MIN_GAMES);
    expect(flag.ordinaryGames).toBe(0);

    // Running it again (e.g. a 6th dark scene-end for the same IP) must not
    // duplicate the flag — dedup via hasEscalationFlagForIp.
    await evaluateEscalation({ repo, ip, gameId: "dark-extra" });
    expect(repo.getEscalationFlags()).toHaveLength(1);
  });

  it("CRITICAL: an otherwise-identical IP with even ONE ordinary game gets NO flag", async () => {
    const repo = new InMemoryGameRepository();
    const ip = "192.0.2.51";
    const rows = [
      ...Array.from({ length: ESCALATION_MIN_GAMES - 1 }, (_, i) => gameRow(`dark-${i}`, DARK_GAME)),
      gameRow("ordinary-0", ORDINARY_ENDING_GAME),
    ];
    await seedGames(repo, ip, rows);

    await evaluateEscalation({ repo, ip, gameId: "ordinary-0" });
    expect(repo.getEscalationFlags()).toHaveLength(0);
  });

  it("returns a no-op without throwing when ip is null", async () => {
    const repo = new InMemoryGameRepository();
    await expect(evaluateEscalation({ repo, ip: null, gameId: "g1" })).resolves.toBeUndefined();
    expect(repo.getEscalationFlags()).toHaveLength(0);
  });

  it("does not flag below ESCALATION_MIN_GAMES", async () => {
    const repo = new InMemoryGameRepository();
    const ip = "192.0.2.52";
    const rows = Array.from({ length: ESCALATION_MIN_GAMES - 1 }, (_, i) => gameRow(`dark-${i}`, DARK_GAME));
    await seedGames(repo, ip, rows);

    await evaluateEscalation({ repo, ip, gameId: rows[rows.length - 1]!.id });
    expect(repo.getEscalationFlags()).toHaveLength(0);
  });
});
