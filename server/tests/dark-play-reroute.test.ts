import { describe, it, expect } from "vitest";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { recordConcern, applyModerationBlock } from "../src/safety/moderation.js";
import { createGame } from "../src/game/state-machine.js";

// These tests call recordConcern / applyModerationBlock directly — they prove
// the tier side-effect functions work in isolation. Routing-layer coverage
// (that "concern" and "block" verdicts actually dispatch to the right one, and
// that the child's turn / session-end / flag / no-auto-ban behaviours hold end
// to end) lives in tests/dark-play-reroute-rest.test.ts, which drives the real
// express routes. (A socket.io equivalent was tried but was too handshake-timing
// fragile to keep in CI; the REST path exercises the same dispatch reliably.)
describe("dark-play reroute (regression)", () => {
  it("concern: session stays alive, IP not banned, event recorded", async () => {
    const repo = new InMemoryGameRepository();
    const state = createGame("Kai");
    await recordConcern({ repo, state, sender: "parent1", reason: "isolation-for-control pattern", ipAddress: "5.5.5.5" });
    expect(state.phase).not.toBe("ended");
    expect(await repo.isIpBanned("5.5.5.5")).toBe(false);
    expect(await repo.loadConcernEvents(state.id)).toHaveLength(1);
  });

  it("block: session ends and a review flag is saved, but the IP is NOT auto-banned", async () => {
    const repo = new InMemoryGameRepository();
    const games = new Map();
    const state = createGame("Kai");
    games.set(state.id, state);
    // Scene-level block uses banIp:false — an LLM scene judgment ends the
    // session + files a flag for human review, but must NOT auto-ban (only the
    // reliable per-message OpenAI check auto-bans).
    await applyModerationBlock({
      repo, games, state, sender: "parent1",
      content: "…", reason: "sexual content directed at the child",
      ipAddress: "6.6.6.6", banIp: false,
    });
    expect(games.get(state.id)!.phase).toBe("ended");
    expect(await repo.isIpBanned("6.6.6.6")).toBe(false);
    expect(await repo.countDistinctFlaggedGamesForIp("6.6.6.6")).toBeGreaterThanOrEqual(1);
  });
});
