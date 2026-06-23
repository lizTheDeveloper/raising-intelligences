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
});
