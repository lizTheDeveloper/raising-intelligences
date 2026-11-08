import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { createGame } from "../src/game/state-machine.js";
import { applyModerationBlock } from "../src/safety/moderation.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { viewEvidence } from "../src/safety/child-safety/vault.js";
import type { GameState } from "../src/types.js";

/**
 * The Terms promise that evidence of child-safety violations is preserved
 * for reporting. A moderation block normally copies its evidence into the
 * vault at flag time; when that write fails, moderation.ts keeps the
 * plaintext in moderation_flags instead — a table that cascades with the
 * game. These tests pin that a game deletion can never take that copy with
 * it, while an ordinary game still deletes completely.
 */

process.env.CHILD_SAFETY_EVIDENCE_KEY ??= randomBytes(32).toString("base64");

const FIXTURE = "TEST FIXTURE: synthetic flagged text, not real content";

afterEach(() => vi.restoreAllMocks());

async function gameFlaggedWhileVaultDown(repo: InMemoryGameRepository): Promise<GameState> {
  const state: GameState = {
    ...createGame("Luna"),
    phase: "family_chat",
    messages: [
      { sender: "parent1", content: "context turn (fixture)", chatType: "shared", visibleTo: ["parent1", "parent2"], timestamp: 1_700_000_000_000, eventNumber: 1 },
    ],
  };
  await repo.saveGame(state);
  for (const m of state.messages) await repo.saveMessage(state.id, m);
  await repo.savePlayer(state.id, "parent1", "P1", "tok", "@flagged:matrix.example");
  // The vault write fails once, at flag time.
  const insert = repo.childSafety.insertCase.bind(repo.childSafety);
  const spy = vi.spyOn(repo.childSafety, "insertCase").mockRejectedValueOnce(new Error("vault down"));
  const { caseId } = await applyModerationBlock({
    repo, games: new Map(), state, sender: "parent1", content: FIXTURE,
    reason: "openai_moderation:sexual/minors", ipAddress: "203.0.113.9", banIp: false,
    classifier: { categories: ["sexual/minors"], scores: { "sexual/minors": 0.9 }, model: "omni-moderation-test" },
  });
  expect(caseId).toBeNull();
  spy.mockImplementation(insert);
  // Precondition: the only copy of the evidence is the plaintext flag row.
  expect(repo.childSafety.cases.size).toBe(0);
  expect(repo.getModerationFlags().find((f) => f.gameId === state.id)?.content).toBe(FIXTURE);
  return state;
}

describe("game deletion keeps child-safety evidence that was not yet in the vault", () => {
  it("moves a plaintext flag into the vault (encrypted) before the game is deleted", async () => {
    const repo = new InMemoryGameRepository();
    const state = await gameFlaggedWhileVaultDown(repo);

    await repo.deleteGameData(state.id);

    expect(await repo.loadGame(state.id)).toBeNull();
    expect(repo.getModerationFlags().filter((f) => f.gameId === state.id)).toHaveLength(0);
    const cases = [...repo.childSafety.cases.values()];
    expect(cases).toHaveLength(1);
    const c = cases[0];
    expect(c.status).toBe("open");
    expect(c.gameRef).toBe(state.id);
    expect(c.ciphertext).not.toContain("TEST FIXTURE");
    const { evidence } = await viewEvidence(repo.childSafety, c.id, "r", null);
    expect(evidence.content).toBe(FIXTURE);
    expect(evidence.reason).toBe("openai_moderation:sexual/minors");
    expect(evidence.categories).toEqual(["sexual/minors"]);
    expect(evidence.sender).toBe("parent1");
    expect(evidence.ipAddress).toBe("203.0.113.9");
    expect(evidence.context.map((t) => t.content)).toContain("context turn (fixture)");
    expect(evidence.identifiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "matrix", value: "@flagged:matrix.example", verified: false, role: "flagged" }),
    ]));
  });

  it("refuses to delete (and loses nothing) when the vault is still unavailable", async () => {
    const repo = new InMemoryGameRepository();
    const state = await gameFlaggedWhileVaultDown(repo);
    vi.spyOn(repo.childSafety, "insertCase").mockRejectedValue(new Error("vault still down"));

    await expect(repo.deleteGameData(state.id)).rejects.toThrow();

    expect(await repo.loadGame(state.id)).not.toBeNull();
    expect(repo.getModerationFlags().find((f) => f.gameId === state.id)?.content).toBe(FIXTURE);
  });

  it("does not duplicate evidence already in the vault", async () => {
    const repo = new InMemoryGameRepository();
    const state: GameState = { ...createGame("Kai"), phase: "family_chat" };
    await repo.saveGame(state);
    const { caseId } = await applyModerationBlock({
      repo, games: new Map(), state, sender: "parent1", content: FIXTURE,
      reason: "openai_moderation:sexual/minors", ipAddress: "203.0.113.10", banIp: false,
      classifier: { categories: ["sexual/minors"], model: "omni-moderation-test" },
    });
    expect(caseId).toBeTruthy();
    await repo.deleteGameData(state.id);
    expect([...repo.childSafety.cases.keys()]).toEqual([caseId]);
  });

  it("an ordinary, unflagged game still deletes completely and opens no case", async () => {
    const repo = new InMemoryGameRepository();
    const state: GameState = { ...createGame("Sol"), phase: "family_chat" };
    await repo.saveGame(state);
    await repo.deleteGameData(state.id);
    expect(await repo.loadGame(state.id)).toBeNull();
    expect(repo.childSafety.cases.size).toBe(0);
  });
});
