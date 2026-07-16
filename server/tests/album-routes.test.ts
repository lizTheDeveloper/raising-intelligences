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
    const res = await fetch(`${server.baseUrl}/api/user/11111111-1111-1111-1111-111111111111/album`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ partners: [], unlinkedKids: [] });
  });

  it("GET /api/user/:userId/album with an invalid userId format returns 400", async () => {
    const res = await fetch(`${server.baseUrl}/api/user/not-a-valid-id/album`);
    expect(res.status).toBe(400);
  });

  it("GET /api/user/:userId/album/kid/nonexistent returns 404", async () => {
    const res = await fetch(
      `${server.baseUrl}/api/user/22222222-2222-2222-2222-222222222222/album/kid/33333333-3333-3333-3333-333333333333`
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data).toEqual({ error: "Kid not found" });
  });

  it("GET /api/user/:userId/album/kid/:gameId with an invalid gameId format returns 400", async () => {
    const res = await fetch(
      `${server.baseUrl}/api/user/22222222-2222-2222-2222-222222222222/album/kid/not-a-uuid`
    );
    expect(res.status).toBe(400);
  });

  it("GET /api/user/:userId/album/kid/:gameId returns scrapbook data when game exists", async () => {
    const userId = "44444444-4444-4444-4444-444444444444";
    const gameId = "55555555-5555-5555-5555-555555555555";

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
    const userId = "66666666-6666-6666-6666-666666666666";
    const gameId = "77777777-7777-7777-7777-777777777777";
    server.memRepo.addUserGame(userId, gameId, "Kai");

    const res = await fetch(`${server.baseUrl}/api/user/${userId}/album`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.partners).toEqual([]);
    expect(data.unlinkedKids).toHaveLength(1);
    expect(data.unlinkedKids[0].childName).toBe("Kai");
    expect(data.unlinkedKids[0].gameId).toBe(gameId);
  });

  it("GET /api/user/:userId/album groups kids under their partner", async () => {
    const userId = "88888888-8888-8888-8888-888888888888";
    const partnerId = "partner-1";

    server.memRepo.addAlbumPartner(userId, {
      id: partnerId,
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Worked well together.",
      kids: [],
    });
    server.memRepo.addUserGame(userId, "99999999-9999-9999-9999-999999999999", "Zoe", partnerId);

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
