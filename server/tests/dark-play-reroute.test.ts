import { describe, it, expect } from "vitest";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { recordConcern, applyModerationBlock } from "../src/safety/moderation.js";
import { createGame } from "../src/game/state-machine.js";

describe("dark-play reroute (regression)", () => {
  it("concern: session stays alive, IP not banned, event recorded", async () => {
    const repo = new InMemoryGameRepository();
    const state = createGame("Kai");
    await recordConcern({ repo, state, sender: "parent1", reason: "isolation-for-control pattern", ipAddress: "5.5.5.5" });
    expect(state.phase).not.toBe("ended");
    expect(await repo.isIpBanned("5.5.5.5")).toBe(false);
    expect(await repo.loadConcernEvents(state.id)).toHaveLength(1);
  });

  it("block: session ends and IP is banned", async () => {
    const repo = new InMemoryGameRepository();
    const games = new Map();
    const state = createGame("Kai");
    games.set(state.id, state);
    await applyModerationBlock({
      repo, games, state, sender: "parent1",
      content: "…", reason: "sexual content directed at the child",
      ipAddress: "6.6.6.6", banIp: true,
    });
    expect(games.get(state.id)!.phase).toBe("ended");
    expect(await repo.isIpBanned("6.6.6.6")).toBe(true);
  });
});
