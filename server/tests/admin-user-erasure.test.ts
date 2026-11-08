import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "net";
import { randomBytes } from "node:crypto";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";
import { applyModerationBlock } from "../src/safety/moderation.js";
import type { GameState } from "../src/types.js";

/**
 * DELETE /api/admin/users/:userId — staff erasure of everything attached to
 * one user id (#141, #144). User ids are client-claimed, so the route must be
 * admin-only, and it must never take child-safety evidence with the games.
 */

process.env.CHILD_SAFETY_EVIDENCE_KEY ??= randomBytes(32).toString("base64");

const TOKEN = "admin-token-for-user-erasure-test";
const FIXTURE = "TEST FIXTURE: synthetic flagged text, not real content";

describe("DELETE /api/admin/users/:userId", () => {
  let built: BuiltServer;
  let base: string;
  let repo: InMemoryGameRepository;
  const saved = process.env.ADMIN_TOKEN;
  let n = 0;

  beforeAll(async () => {
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: new MockLLMClient(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => { await built.close(); });
  beforeEach(() => { process.env.ADMIN_TOKEN = TOKEN; });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved;
  });

  const uid = () => `@erase${++n}:matrix.example`;

  async function storedGame(name: string): Promise<GameState> {
    const state: GameState = { ...createGame(name), phase: "family_chat" };
    await repo.saveGame(state);
    built.games.set(state.id, state);
    return state;
  }

  const erase = (userId: string, auth?: string) =>
    fetch(`${base}/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: auth ? { Authorization: auth } : {},
    });

  it("rejects a missing or wrong token and leaves the data intact", async () => {
    const user = uid();
    const g = await storedGame("Kai");
    await repo.saveUserGame(user, g.id, "Kai");

    expect((await erase(user)).status).toBe(401);
    expect((await erase(user, "Bearer nope")).status).toBe(401);
    expect(await repo.loadGame(g.id)).not.toBeNull();
    expect(built.games.has(g.id)).toBe(true);
    expect(await repo.listGameIdsForUser(user)).toEqual([g.id]);
  });

  it("fails closed when ADMIN_TOKEN is unset", async () => {
    const user = uid();
    const g = await storedGame("Kai");
    await repo.saveUserGame(user, g.id, "Kai");
    delete process.env.ADMIN_TOKEN;

    expect((await erase(user, "Bearer undefined")).status).toBe(503);
    expect((await erase(user, "Bearer ")).status).toBe(503);
    expect(await repo.loadGame(g.id)).not.toBeNull();
  });

  it("is not reachable without the admin prefix (no self-service DELETE /api/user/:userId)", async () => {
    const user = uid();
    const g = await storedGame("Kai");
    await repo.saveUserGame(user, g.id, "Kai");

    const res = await fetch(`${base}/user/${encodeURIComponent(user)}`, { method: "DELETE" });
    expect(res.status).not.toBe(200);
    expect(await repo.loadGame(g.id)).not.toBeNull();
  });

  it("answers 400 for a malformed user id", async () => {
    expect((await erase("not a user id", `Bearer ${TOKEN}`)).status).toBe(400);
  });

  it("erases every game attached to the user, their links and album partners, and nobody else's", async () => {
    const user = uid();
    const other = uid();
    const linked = await storedGame("Linked");
    await repo.saveUserGame(user, linked.id, "Linked");
    const seated = await storedGame("Seated");
    await repo.savePlayer(seated.id, "parent2", "P2", "tok-seat", user);
    const partnerId = await repo.saveAlbumPartner({ userId: user, partnerName: "Sam", partnerType: "real", relationshipSummary: "s" });
    await repo.linkGameToPartner(user, linked.id, partnerId);
    const theirs = await storedGame("Theirs");
    await repo.saveUserGame(other, theirs.id, "Theirs");

    const res = await erase(user, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedGameIds: string[] };
    expect(body.deletedGameIds.sort()).toEqual([linked.id, seated.id].sort());

    for (const id of [linked.id, seated.id]) {
      expect(await repo.loadGame(id)).toBeNull();
      expect(built.games.has(id)).toBe(false);
      expect((await fetch(`${base}/game/${id}/state`)).status).toBe(404);
    }
    expect(await repo.listGameIdsForUser(user)).toEqual([]);
    const album = await repo.loadAlbum(user);
    expect(album.partners).toEqual([]);
    expect(album.unlinkedKids).toEqual([]);

    expect(await repo.loadGame(theirs.id)).not.toBeNull();
    expect(await repo.listGameIdsForUser(other)).toEqual([theirs.id]);

    // Idempotent: a second request finds nothing left.
    const again = await erase(user, `Bearer ${TOKEN}`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { deletedGameIds: string[] }).deletedGameIds).toEqual([]);
  });

  async function flaggedWhileVaultDown(user: string): Promise<GameState> {
    const state = await storedGame("Luna");
    await repo.saveUserGame(user, state.id, "Luna");
    const insert = repo.childSafety.insertCase.bind(repo.childSafety);
    const spy = vi.spyOn(repo.childSafety, "insertCase").mockRejectedValueOnce(new Error("vault down"));
    const { caseId } = await applyModerationBlock({
      repo, games: new Map(), state, sender: "parent1", content: FIXTURE,
      reason: "openai_moderation:sexual/minors", ipAddress: "203.0.113.9", banIp: false,
      classifier: { categories: ["sexual/minors"], model: "omni-moderation-test" },
    });
    expect(caseId).toBeNull();
    spy.mockImplementation(insert);
    expect(repo.getModerationFlags().find((f) => f.gameId === state.id)?.content).toBe(FIXTURE);
    return state;
  }

  it("moves un-vaulted child-safety evidence into the vault instead of deleting it", async () => {
    const user = uid();
    const state = await flaggedWhileVaultDown(user);
    const casesBefore = repo.childSafety.cases.size;

    expect((await erase(user, `Bearer ${TOKEN}`)).status).toBe(200);

    expect(await repo.loadGame(state.id)).toBeNull();
    const cases = [...repo.childSafety.cases.values()].filter((c) => c.gameRef === state.id);
    expect(repo.childSafety.cases.size).toBe(casesBefore + 1);
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe("open");
    expect(cases[0].ciphertext).not.toContain("TEST FIXTURE");
  });

  it("deletes nothing for a flagged game while the vault is unavailable", async () => {
    const user = uid();
    const state = await flaggedWhileVaultDown(user);
    vi.spyOn(repo.childSafety, "insertCase").mockRejectedValue(new Error("vault still down"));

    const res = await erase(user, `Bearer ${TOKEN}`);
    expect(res.status).toBeGreaterThanOrEqual(500);

    expect(await repo.loadGame(state.id)).not.toBeNull();
    expect(repo.getModerationFlags().find((f) => f.gameId === state.id)?.content).toBe(FIXTURE);
    expect(await repo.listGameIdsForUser(user)).toEqual([state.id]);
  });
});

// Needs DATABASE_URL pointing at a database with all migrations applied.
describe.skipIf(!process.env.DATABASE_URL)("PgGameRepository user erasure (Postgres)", () => {
  it("finds a user's games by link, seat and campus id, and clears links and album partners", async () => {
    const { pool } = await import("../src/db/pool.js");
    const { PgGameRepository } = await import("../src/db/repository.js");
    const { randomUUID } = await import("crypto");
    const repo = new PgGameRepository(pool);
    const user = `@pg-erase-${randomUUID()}:matrix.example`;
    const campus = `@pg-erase-${randomUUID().slice(0, 8)}:themultiverse.school`;
    const [linked, seated, campusGame, theirs] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const id of [linked, seated, campusGame, theirs]) {
      await pool.query(
        `INSERT INTO games (id, child_name, relationship_type, phase) VALUES ($1, 'Kai', 'co-parents', 'event_intro')`,
        [id],
      );
    }
    await repo.saveUserGame(user, linked, "Kai");
    await repo.savePlayer(seated, "parent2", "P2", `tok-${randomUUID()}`, user);
    await pool.query(`UPDATE games SET campus_sub = $1 WHERE id = $2`, [campus, campusGame]);
    await repo.saveUserGame("@someone-else:matrix.example", theirs, "Kai");
    const partnerId = await repo.saveAlbumPartner({ userId: user, partnerName: "Sam", partnerType: "real", relationshipSummary: "s" });
    await repo.linkGameToPartner(user, linked, partnerId);

    expect((await repo.listGameIdsForUser(user)).sort()).toEqual([linked, seated].sort());
    expect(await repo.listGameIdsForUser(campus)).toEqual([campusGame]);

    await repo.deleteUserRecords(user);
    const { rows: ug } = await pool.query(`SELECT 1 FROM user_games WHERE user_id = $1`, [user]);
    expect(ug).toHaveLength(0);
    const { rows: ap } = await pool.query(`SELECT 1 FROM album_partners WHERE user_id = $1`, [user]);
    expect(ap).toHaveLength(0);

    for (const id of [linked, seated, campusGame, theirs]) await repo.deleteGameData(id);
    await pool.query(`DELETE FROM user_games WHERE game_id = $1`, [theirs]);
  });
});
