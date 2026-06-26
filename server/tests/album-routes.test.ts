import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";

describe("Album API routes", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer("album-routes");
  });

  afterAll(async () => {
    await server.stop();
  });

  it("GET /api/user/:userId/album returns empty album for user with no games", async () => {
    const res = await fetch(`${server.baseUrl}/api/user/unknown-user/album`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ partners: [], unlinkedKids: [] });
  });

  it("GET /api/user/:userId/album/kid/nonexistent returns 404", async () => {
    const res = await fetch(
      `${server.baseUrl}/api/user/some-user/album/kid/nonexistent`
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data).toEqual({ error: "Kid not found" });
  });

  it("GET /api/user/:userId/album/kid/:gameId returns scrapbook data when game exists", async () => {
    const userId = "test-user-album";
    const gameId = "album-game-1";

    server.memRepo.addUserGame(userId, gameId, "Luna");
    await server.memRepo.saveEndgame(gameId, "Luna grew up well.", "# Report Card\nA+");

    const res = await fetch(
      `${server.baseUrl}/api/user/${userId}/album/kid/${gameId}`
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.childName).toBe("Luna");
    expect(data.epilogue).toBe("Luna grew up well.");
    expect(data.reportCard).toBe("# Report Card\nA+");
    expect(data.moments).toEqual([]);
    expect(data.portraits).toEqual([]);
    expect(data.partnerName).toBeNull();
    expect(data.partnerType).toBeNull();
    expect(data.relationshipSummary).toBeNull();
  });

  it("GET /api/user/:userId/album returns unlinked kids when no partner is assigned", async () => {
    const userId = "test-user-unlinked";
    server.memRepo.addUserGame(userId, "game-unlinked-1", "Kai");

    const res = await fetch(`${server.baseUrl}/api/user/${userId}/album`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.partners).toEqual([]);
    expect(data.unlinkedKids).toHaveLength(1);
    expect(data.unlinkedKids[0].childName).toBe("Kai");
    expect(data.unlinkedKids[0].gameId).toBe("game-unlinked-1");
  });

  it("GET /api/user/:userId/album groups kids under their partner", async () => {
    const userId = "test-user-partner";
    const partnerId = "partner-1";

    server.memRepo.addAlbumPartner(userId, {
      id: partnerId,
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Worked well together.",
      kids: [],
    });
    server.memRepo.addUserGame(userId, "game-partner-1", "Zoe", partnerId);

    const res = await fetch(`${server.baseUrl}/api/user/${userId}/album`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.unlinkedKids).toEqual([]);
    expect(data.partners).toHaveLength(1);
    expect(data.partners[0].partnerName).toBe("Alex");
    expect(data.partners[0].kids).toHaveLength(1);
    expect(data.partners[0].kids[0].childName).toBe("Zoe");
  });
});
