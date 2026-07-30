import { describe, it, expect } from "vitest";
import {
  createGame,
  transition,
  concernDeltaForTier,
  CONCERN_MAX,
  CONCERN_INCREMENT,
  CONCERN_DECAY,
} from "../src/game/state-machine.js";
import { InMemoryGameRepository } from "../src/db/repository.js";

describe("concern accumulator — reducer + delta helper", () => {
  it("new games start at concernLevel 0", () => {
    expect(createGame("Kai").concernLevel).toBe(0);
  });

  it("concernDeltaForTier maps tiers to signed deltas", () => {
    expect(concernDeltaForTier("concern")).toBe(CONCERN_INCREMENT);
    expect(concernDeltaForTier("none")).toBe(-CONCERN_DECAY);
    expect(concernDeltaForTier("block")).toBe(0);
  });

  it("CONCERN_ACCRUED raises the level by a positive delta", () => {
    const s = createGame("Kai");
    const next = transition(s, { type: "CONCERN_ACCRUED", delta: CONCERN_INCREMENT });
    expect(next.concernLevel).toBe(CONCERN_INCREMENT);
  });

  it("CONCERN_ACCRUED clamps at CONCERN_MAX", () => {
    let s = createGame("Kai");
    for (let i = 0; i < 100; i++) s = transition(s, { type: "CONCERN_ACCRUED", delta: CONCERN_INCREMENT });
    expect(s.concernLevel).toBe(CONCERN_MAX);
  });

  it("CONCERN_ACCRUED floors at 0 (a clean scene on a clean game cannot go negative)", () => {
    const s = createGame("Kai");
    const next = transition(s, { type: "CONCERN_ACCRUED", delta: -CONCERN_DECAY });
    expect(next.concernLevel).toBe(0);
  });

  it("rise then decay: two concerns then one clean scene nets one increment minus one decay", () => {
    let s = createGame("Kai");
    s = transition(s, { type: "CONCERN_ACCRUED", delta: concernDeltaForTier("concern") });
    s = transition(s, { type: "CONCERN_ACCRUED", delta: concernDeltaForTier("concern") });
    s = transition(s, { type: "CONCERN_ACCRUED", delta: concernDeltaForTier("none") });
    expect(s.concernLevel).toBe(CONCERN_INCREMENT * 2 - CONCERN_DECAY);
  });
});

describe("concern accumulator — persistence (in-memory repo)", () => {
  it("round-trips concernLevel through save/load", async () => {
    const repo = new InMemoryGameRepository();
    let s = createGame("Kai");
    s = transition(s, { type: "CONCERN_ACCRUED", delta: 5 });
    expect(s.concernLevel).toBe(5);
    await repo.saveGame(s);
    const loaded = await repo.loadGame(s.id);
    expect(loaded?.concernLevel).toBe(5);
  });

  it("a freshly loaded game with no stored concern defaults to 0", async () => {
    const repo = new InMemoryGameRepository();
    const s = createGame("Kai");
    await repo.saveGame(s);
    const loaded = await repo.loadGame(s.id);
    expect(loaded?.concernLevel).toBe(0);
  });
});
