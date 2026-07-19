import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";

describe("Admin API routes", () => {
  let server: TestServer;

  beforeAll(async () => {
    process.env.ADMIN_TOKEN = "test-admin-secret";
    server = await createTestServer("admin-routes");
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.ADMIN_TOKEN;
  });

  it("rejects requests without auth token", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/overview`);
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong token", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/overview`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns overview stats for authenticated admin", async () => {
    server.adminQueries.addGame({
      id: "g1",
      childName: "Luna",
      phase: "family_chat",
      currentEventNumber: 1,
      totalEvents: 10,
      relationshipType: "co-parents",
      identityDocument: "",
      sidebarUsedParent1: false,
      sidebarUsedParent2: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await fetch(`${server.baseUrl}/api/admin/overview`, {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalGames).toBe(1);
    expect(data.activeGames).toBe(1);
  });

  it("returns game list with status filter", async () => {
    const now = new Date();
    server.adminQueries.addGame({
      id: "completed-1",
      childName: "Max",
      phase: "ended",
      currentEventNumber: 10,
      totalEvents: 10,
      relationshipType: "co-parents",
      identityDocument: "",
      sidebarUsedParent1: false,
      sidebarUsedParent2: false,
      createdAt: now,
      updatedAt: now,
    });
    server.adminQueries.addEndgame("completed-1", { epilogue: "done", reportCard: "# Max" });

    const res = await fetch(`${server.baseUrl}/api/admin/games?status=completed`, {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.games.length).toBeGreaterThanOrEqual(1);
    expect(data.games.some((g: { id: string }) => g.id === "completed-1")).toBe(true);
  });

  it("returns game detail", async () => {
    const now = new Date();
    server.adminQueries.addGame({
      id: "detail-1",
      childName: "Zoe",
      phase: "family_chat",
      currentEventNumber: 1,
      totalEvents: 10,
      relationshipType: "co-parents",
      identityDocument: "Core beliefs.",
      sidebarUsedParent1: false,
      sidebarUsedParent2: false,
      createdAt: now,
      updatedAt: now,
    });
    server.adminQueries.addEvent("detail-1", {
      eventNumber: 1, age: 4, description: "Broke a vase",
      setting: "Living room", trigger: "Accident", createdAt: now,
    });

    const res = await fetch(`${server.baseUrl}/api/admin/games/detail-1`, {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.childName).toBe("Zoe");
    expect(data.events).toHaveLength(1);
  });

  it("returns 404 for unknown game detail", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/games/nonexistent`, {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    expect(res.status).toBe(404);
  });

  const authed = { Authorization: "Bearer test-admin-secret" };

  it("lists moderation flags with per-IP ban state enrichment", async () => {
    server.adminQueries.addGame({
      id: "flagged-game",
      childName: "Robin",
      phase: "ended",
      currentEventNumber: 3,
      totalEvents: 10,
      relationshipType: "co-parents",
      identityDocument: "",
      sidebarUsedParent1: false,
      sidebarUsedParent2: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    server.adminQueries.addModerationFlag({
      gameId: "flagged-game",
      sender: "parent1",
      reason: "sustained verbal abuse toward the child",
      content: "the scene transcript",
      ipAddress: "203.0.113.7",
    });
    server.adminQueries.addModerationFlag({
      gameId: "flagged-game",
      sender: "parent1",
      reason: "another scene, different ip",
      ipAddress: "203.0.113.99",
    });
    // Ban one of the two IPs directly in the repo.
    await server.memRepo.banIp("203.0.113.7", "prior");

    const res = await fetch(`${server.baseUrl}/api/admin/moderation-flags`, { headers: authed });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBeGreaterThanOrEqual(2);

    const banned = data.flags.find((f: { ipAddress: string }) => f.ipAddress === "203.0.113.7");
    const notBanned = data.flags.find((f: { ipAddress: string }) => f.ipAddress === "203.0.113.99");
    expect(banned).toMatchObject({ banned: true, childName: "Robin", sender: "parent1" });
    expect(notBanned).toMatchObject({ banned: false });
  });

  it("bans an IP via POST /admin/moderation/ban", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/moderation/ban`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "198.51.100.5", reason: "manual review" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, ip: "198.51.100.5", banned: true });
    expect(await server.memRepo.isIpBanned("198.51.100.5")).toBe(true);
  });

  it("unbans an IP via POST /admin/moderation/unban", async () => {
    await server.memRepo.banIp("198.51.100.6", "prior");
    const res = await fetch(`${server.baseUrl}/api/admin/moderation/unban`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "198.51.100.6" }),
    });
    expect(res.status).toBe(200);
    expect(await server.memRepo.isIpBanned("198.51.100.6")).toBe(false);
  });

  it("rejects a ban with no ip (400)", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/moderation/ban`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "no ip here" }),
    });
    expect(res.status).toBe(400);
  });
});
