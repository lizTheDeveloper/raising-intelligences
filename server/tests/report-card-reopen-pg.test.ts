import { describe, it, expect, beforeAll } from "vitest";
import type { GameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";

// Needs DATABASE_URL pointing at a scratch Postgres (see docs/host-tools-test-harness.md §4).
describe.skipIf(!process.env.DATABASE_URL)("a finished game rehydrated from Postgres keeps its report card", () => {
  let repo: GameRepository;

  beforeAll(async () => {
    const { pool } = await import("../src/db/pool.js");
    const { migrate } = await import("../src/db/migrate.js");
    await migrate();
    const { PgGameRepository } = await import("../src/db/repository.js");
    repo = new PgGameRepository(pool);
  });

  it("loadGame restores the report card and epilogue from the endgames row", async () => {
    const game = { ...createGame("Wren", "friends"), phase: "report_card" as const };
    await repo.saveGame(game);
    await repo.saveEndgame(game.id, "Wren kept bees.", "# Wren\nnotices everything.");
    const loaded = await repo.loadGame(game.id);
    expect(loaded?.phase).toBe("report_card");
    expect(loaded?.reportCard).toBe("# Wren\nnotices everything.");
    expect(loaded?.epilogue).toBe("Wren kept bees.");
  });

  it("a game with no endgame yet comes back with both empty", async () => {
    const game = createGame("Ivy", "friends");
    await repo.saveGame(game);
    const loaded = await repo.loadGame(game.id);
    expect(loaded?.reportCard).toBe("");
    expect(loaded?.epilogue).toBe("");
  });
});
