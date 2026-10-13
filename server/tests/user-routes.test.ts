import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";
import { createGame } from "../src/game/state-machine.js";

describe("DELETE /api/user/:userId (data-subject erasure, issue #141)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer("user-routes");
  });

  afterAll(async () => {
    await server.stop();
  });

  it("rejects an invalid userId format", async () => {
    const del = await fetch(`${server.baseUrl}/api/user/${encodeURIComponent("not valid!")}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(400);
    expect(await del.json()).toEqual({ error: "Invalid userId format" });
  });

  it("deletes a user's games, evicts them from the live cache, and returns the deleted ids", async () => {
    const userId = "22222222-2222-2222-2222-222222222222";
    const game = createGame("Luna");
    const gameId = game.id;

    server.games.set(gameId, game);
    await server.memRepo.saveGame(game);
    await server.memRepo.addUserGame(userId, gameId, "Luna");
    server.memRepo.addAlbumPartner(userId, {
      id: "partner-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "co-parented Luna",
      kids: [],
    });

    const res = await fetch(`${server.baseUrl}/api/user/${userId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deletedGameIds: [gameId] });

    // Evicted from the live in-memory cache used by the game routes.
    expect(server.games.has(gameId)).toBe(false);

    // Gone from the repository too, not just the live cache.
    expect(await server.memRepo.loadGame(gameId)).toBeNull();

    // The album partner (not linked to a game via FK cascade) is gone.
    const album = await fetch(`${server.baseUrl}/api/user/${userId}/album`);
    expect(await album.json()).toEqual({ partners: [], unlinkedKids: [] });
  });

  it("is a no-op (200, empty list) for a userId with no data", async () => {
    const res = await fetch(`${server.baseUrl}/api/user/33333333-3333-3333-3333-333333333333`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deletedGameIds: [] });
  });
});
