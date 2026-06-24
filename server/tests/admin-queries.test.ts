import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";

describe("AdminQueries", () => {
  let aq: InMemoryAdminQueries;

  beforeEach(() => {
    aq = new InMemoryAdminQueries();
  });

  describe("getOverview", () => {
    it("returns zeroes when no games exist", async () => {
      const stats = await aq.getOverview();
      expect(stats).toEqual({
        totalGames: 0,
        activeGames: 0,
        completedGames: 0,
        abandonedGames: 0,
      });
    });

    it("counts active, completed, and abandoned games", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

      aq.addGame({
        id: "active-1",
        childName: "Luna",
        phase: "family_chat",
        currentEventNumber: 3,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: now,
        updatedAt: now,
      });

      aq.addGame({
        id: "completed-1",
        childName: "Max",
        phase: "ended",
        currentEventNumber: 10,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: oldDate,
        updatedAt: oldDate,
      });
      aq.addEndgame("completed-1", { epilogue: "grew up", reportCard: "# Max" });

      aq.addGame({
        id: "abandoned-1",
        childName: "Zoe",
        phase: "debrief",
        currentEventNumber: 5,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: oldDate,
        updatedAt: oldDate,
      });

      const stats = await aq.getOverview();
      expect(stats.totalGames).toBe(3);
      expect(stats.activeGames).toBe(1);
      expect(stats.completedGames).toBe(1);
      expect(stats.abandonedGames).toBe(1);
    });
  });

  describe("listGames", () => {
    it("returns all games sorted by updatedAt descending", async () => {
      const old = new Date("2026-06-01");
      const recent = new Date("2026-06-20");

      aq.addGame({
        id: "game-old",
        childName: "Old",
        phase: "ended",
        currentEventNumber: 10,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: old,
        updatedAt: old,
      });
      aq.addEndgame("game-old", { epilogue: "done", reportCard: "# Old" });

      aq.addGame({
        id: "game-recent",
        childName: "Recent",
        phase: "family_chat",
        currentEventNumber: 2,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: recent,
        updatedAt: recent,
      });
      aq.addPlayer("game-recent", { slot: "parent1", displayName: "Alice" });

      const result = await aq.listGames();
      expect(result.total).toBe(2);
      expect(result.games[0].id).toBe("game-recent");
      expect(result.games[0].players).toEqual([{ slot: "parent1", displayName: "Alice" }]);
      expect(result.games[1].id).toBe("game-old");
      expect(result.games[1].hasEndgame).toBe(true);
    });

    it("filters by status", async () => {
      const now = new Date();
      aq.addGame({
        id: "active-1",
        childName: "Active",
        phase: "family_chat",
        currentEventNumber: 1,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: now,
        updatedAt: now,
      });
      aq.addGame({
        id: "completed-1",
        childName: "Done",
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
      aq.addEndgame("completed-1", { epilogue: "done", reportCard: "# Done" });

      const active = await aq.listGames({ status: "active" });
      expect(active.total).toBe(1);
      expect(active.games[0].childName).toBe("Active");

      const completed = await aq.listGames({ status: "completed" });
      expect(completed.total).toBe(1);
      expect(completed.games[0].childName).toBe("Done");
    });

    it("paginates with limit and offset", async () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        aq.addGame({
          id: `game-${i}`,
          childName: `Kid ${i}`,
          phase: "family_chat",
          currentEventNumber: 1,
          totalEvents: 10,
          relationshipType: "co-parents",
          identityDocument: "",
          sidebarUsedParent1: false,
          sidebarUsedParent2: false,
          createdAt: now,
          updatedAt: new Date(now.getTime() + i * 1000),
        });
      }

      const page = await aq.listGames({ limit: 2, offset: 1 });
      expect(page.total).toBe(5);
      expect(page.games).toHaveLength(2);
      expect(page.games[0].id).toBe("game-3");
      expect(page.games[1].id).toBe("game-2");
    });
  });

  describe("getGameDetail", () => {
    it("returns null for unknown game", async () => {
      expect(await aq.getGameDetail("missing")).toBeNull();
    });

    it("returns full game detail with events, messages, snapshots", async () => {
      const now = new Date();
      aq.addGame({
        id: "game-1",
        childName: "Luna",
        phase: "debrief",
        currentEventNumber: 2,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "Core beliefs: the world is safe.",
        sidebarUsedParent1: true,
        sidebarUsedParent2: false,
        createdAt: now,
        updatedAt: now,
      });
      aq.addPlayer("game-1", { slot: "parent1", displayName: "Alice" });
      aq.addEvent("game-1", {
        eventNumber: 1, age: 4, description: "Broke a vase",
        setting: "Living room", trigger: "Accident", createdAt: now,
      });
      aq.addMessage("game-1", { sender: "parent1", eventNumber: 1 });
      aq.addMessage("game-1", { sender: "parent1", eventNumber: 1 });
      aq.addMessage("game-1", { sender: "kid", eventNumber: 1 });
      aq.addSnapshot("game-1", { eventNumber: 1, document: "v1 doc" });

      const detail = await aq.getGameDetail("game-1");
      expect(detail).not.toBeNull();
      expect(detail!.childName).toBe("Luna");
      expect(detail!.events).toHaveLength(1);
      expect(detail!.events[0].age).toBe(4);
      expect(detail!.messageCounts).toEqual([
        { eventNumber: 1, parent1: 2, parent2: 0, kid: 1 },
      ]);
      expect(detail!.identitySnapshots).toEqual([
        { eventNumber: 1, document: "v1 doc" },
      ]);
      expect(detail!.sidebarUsed.parent1).toBe(true);
      expect(detail!.endgame).toBeNull();
    });

    it("includes endgame when completed", async () => {
      const now = new Date();
      aq.addGame({
        id: "game-1",
        childName: "Luna",
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
      aq.addEndgame("game-1", { epilogue: "grew up", reportCard: "# Luna" });

      const detail = await aq.getGameDetail("game-1");
      expect(detail!.endgame).toEqual({ epilogue: "grew up", reportCard: "# Luna" });
    });
  });
});
