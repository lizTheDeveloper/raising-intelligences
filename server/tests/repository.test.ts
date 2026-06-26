import { describe, it, expect } from "vitest";
import { InMemoryGameRepository } from "../src/db/repository.js";
import type { GameEvent, GameState, Message } from "../src/types.js";

function baseState(overrides: Partial<GameState> = {}): GameState {
  return {
    id: "game-1",
    phase: "family_chat",
    childName: "Luna",
    relationshipType: "co-parents",
    currentEvent: null,
    currentEventNumber: 1,
    totalEvents: 10,
    identityDocument: "Core beliefs: the world is safe.",
    identitySnapshots: [],
    events: [],
    messages: [],
    parentMessageCount: 0,
    sidebarUsed: { parent1: false, parent2: false },
    sidebarActive: null,
    lastActivityAt: 0,
    ...overrides,
  };
}

const event1: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

describe("InMemoryGameRepository", () => {
  it("returns null for an unknown game", async () => {
    const repo = new InMemoryGameRepository();
    expect(await repo.loadGame("missing")).toBeNull();
  });

  it("round-trips a saved game checkpoint", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState());

    const loaded = await repo.loadGame("game-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("game-1");
    expect(loaded!.childName).toBe("Luna");
    expect(loaded!.relationshipType).toBe("co-parents");
    expect(loaded!.phase).toBe("family_chat");
    expect(loaded!.currentEventNumber).toBe(1);
    expect(loaded!.identityDocument).toBe(
      "Core beliefs: the world is safe."
    );
  });

  it("upserts the game checkpoint on repeated saves", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ phase: "family_chat" }));
    await repo.saveGame(
      baseState({ phase: "debrief", identityDocument: "Updated doc." })
    );

    const loaded = await repo.loadGame("game-1");
    expect(loaded!.phase).toBe("debrief");
    expect(loaded!.identityDocument).toBe("Updated doc.");
  });

  it("reconstructs events and sets currentEvent from currentEventNumber", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ currentEventNumber: 1 }));
    await repo.saveEvent("game-1", event1);

    const loaded = await repo.loadGame("game-1");
    expect(loaded!.events).toHaveLength(1);
    expect(loaded!.currentEvent).toEqual(event1);
  });

  it("persists messages and reconstructs them in timestamp order", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState());

    const m1: Message = {
      sender: "parent1",
      content: "It's okay, accidents happen.",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 100,
      eventNumber: 1,
    };
    const m2: Message = {
      sender: "kid",
      content: "I didn't mean to!",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 200,
      eventNumber: 1,
    };
    // Save out of order to verify sorting.
    await repo.saveMessage("game-1", m2);
    await repo.saveMessage("game-1", m1);

    const loaded = await repo.loadGame("game-1");
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].content).toBe("It's okay, accidents happen.");
    expect(loaded!.messages[1].content).toBe("I didn't mean to!");
    expect(loaded!.messages[0].visibleTo).toEqual([
      "parent1",
      "parent2",
      "kid",
    ]);
  });

  it("recomputes parentMessageCount from persisted messages when in chat", async () => {
    const repo = new InMemoryGameRepository();
    // currentEventNumber is 1 in baseState; messages must carry the matching
    // eventNumber so reconstructState can filter to the current event only.
    await repo.saveGame(baseState({ phase: "family_chat" }));
    await repo.saveMessage("game-1", {
      sender: "parent1",
      content: "a",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 1,
      eventNumber: 1,
    });
    await repo.saveMessage("game-1", {
      sender: "kid",
      content: "b",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 2,
      eventNumber: 1,
    });
    await repo.saveMessage("game-1", {
      sender: "parent2",
      content: "c",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 3,
      eventNumber: 1,
    });

    const loaded = await repo.loadGame("game-1");
    expect(loaded!.parentMessageCount).toBe(2);
  });

  it("does not count parent messages from earlier events towards the cap", async () => {
    const repo = new InMemoryGameRepository();
    // Simulate a game currently on event 3 (family_chat phase) that has
    // accumulated messages from events 1 and 2 in the DB.
    await repo.saveGame(baseState({ phase: "family_chat", currentEventNumber: 3 }));
    // 6 parent messages from event 1
    for (let i = 0; i < 6; i++) {
      await repo.saveMessage("game-1", {
        sender: "parent1", content: `e1-${i}`, chatType: "shared",
        visibleTo: ["parent1", "parent2", "kid"], timestamp: i, eventNumber: 1,
      });
    }
    // 6 parent messages from event 2
    for (let i = 0; i < 6; i++) {
      await repo.saveMessage("game-1", {
        sender: "parent1", content: `e2-${i}`, chatType: "shared",
        visibleTo: ["parent1", "parent2", "kid"], timestamp: 10 + i, eventNumber: 2,
      });
    }
    // 3 parent messages so far in the CURRENT event (event 3)
    for (let i = 0; i < 3; i++) {
      await repo.saveMessage("game-1", {
        sender: "parent1", content: `e3-${i}`, chatType: "shared",
        visibleTo: ["parent1", "parent2", "kid"], timestamp: 20 + i, eventNumber: 3,
      });
    }

    const loaded = await repo.loadGame("game-1");
    // Must be 3, not 15 (which is what the buggy all-messages count would give).
    expect(loaded!.parentMessageCount).toBe(3);
  });

  it("persists and reconstructs identity snapshots, upserting by event number", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState());
    await repo.saveSnapshot("game-1", {
      eventNumber: 1,
      document: "v1",
    });
    await repo.saveSnapshot("game-1", {
      eventNumber: 2,
      document: "v2",
    });
    // Overwrite snapshot 1.
    await repo.saveSnapshot("game-1", {
      eventNumber: 1,
      document: "v1-updated",
    });

    const loaded = await repo.loadGame("game-1");
    expect(loaded!.identitySnapshots).toHaveLength(2);
    expect(loaded!.identitySnapshots[0]).toEqual({
      eventNumber: 1,
      document: "v1-updated",
    });
    expect(loaded!.identitySnapshots[1]).toEqual({
      eventNumber: 2,
      document: "v2",
    });
  });

  it("stores the endgame artifacts", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ phase: "ended" }));
    await repo.saveEndgame("game-1", "They grew up thoughtful.", "# Luna");

    const endgame = await repo.getEndgame("game-1");
    expect(endgame).toEqual({
      epilogue: "They grew up thoughtful.",
      reportCard: "# Luna",
    });
  });

  it("does not leak data between games", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ id: "game-1" }));
    await repo.saveGame(baseState({ id: "game-2", childName: "Max" }));
    await repo.saveMessage("game-1", {
      sender: "parent1",
      content: "only in game 1",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 1,
      eventNumber: 1,
    });

    const g2 = await repo.loadGame("game-2");
    expect(g2!.childName).toBe("Max");
    expect(g2!.messages).toHaveLength(0);
  });

  it("returns a deep copy so mutations don't bleed back into the store", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState());
    await repo.saveMessage("game-1", {
      sender: "parent1",
      content: "original",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 1,
      eventNumber: 1,
    });

    const loaded = await repo.loadGame("game-1");
    loaded!.messages[0].content = "mutated";
    loaded!.messages[0].visibleTo.push("kid");

    const reloaded = await repo.loadGame("game-1");
    expect(reloaded!.messages[0].content).toBe("original");
    expect(reloaded!.messages[0].visibleTo).toEqual([
      "parent1",
      "parent2",
      "kid",
    ]);
  });
});

describe("Album features", () => {
  it("saveAlbumPartner creates a partner and returns an ID", async () => {
    const repo = new InMemoryGameRepository();
    const id = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Co-parents since 2020",
    });
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("saveAlbumPartner upserts and returns the same ID on conflict", async () => {
    const repo = new InMemoryGameRepository();
    const id1 = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Co-parents since 2020",
    });
    const id2 = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Updated summary",
    });
    expect(id2).toBe(id1);
  });

  it("saveAlbumPartner creates separate partners for different types", async () => {
    const repo = new InMemoryGameRepository();
    const id1 = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Real partner",
    });
    const id2 = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "generated",
      relationshipSummary: "AI partner",
    });
    expect(id1).not.toBe(id2);
  });

  it("saveAlbumMoments saves moments retrievable via loadScrapbook", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ id: "game-1" }));
    await repo.addUserGame("user-1", "game-1", "Luna");

    await repo.saveAlbumMoments("game-1", [
      { age: 3, title: "First steps", description: "Luna took her first steps!", momentType: "milestone", imagePath: null, sortOrder: 0 },
      { age: 5, title: "School day", description: "Luna's first day of school.", momentType: "event", imagePath: "/img/school.png", sortOrder: 1 },
    ]);

    const scrapbook = await repo.loadScrapbook("user-1", "game-1");
    expect(scrapbook).not.toBeNull();
    expect(scrapbook!.moments).toHaveLength(2);
    expect(scrapbook!.moments[0].title).toBe("First steps");
    expect(scrapbook!.moments[0].age).toBe(3);
    expect(scrapbook!.moments[0].imagePath).toBeNull();
    expect(scrapbook!.moments[1].title).toBe("School day");
    expect(scrapbook!.moments[1].imagePath).toBe("/img/school.png");
  });

  it("linkGameToPartner links a game that shows up in loadAlbum", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ id: "game-1" }));
    await repo.addUserGame("user-1", "game-1", "Luna");

    const partnerId = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Co-parents",
    });
    await repo.linkGameToPartner("user-1", "game-1", partnerId);

    const album = await repo.loadAlbum("user-1");
    expect(album.partners).toHaveLength(1);
    expect(album.partners[0].partnerName).toBe("Alex");
    expect(album.partners[0].kids).toHaveLength(1);
    expect(album.partners[0].kids[0].gameId).toBe("game-1");
    expect(album.partners[0].kids[0].childName).toBe("Luna");
    expect(album.unlinkedKids).toHaveLength(0);
  });

  it("loadAlbum returns grouped partners with kids and unlinked kids", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ id: "game-1" }));
    await repo.saveGame(baseState({ id: "game-2", childName: "Max" }));
    await repo.saveGame(baseState({ id: "game-3", childName: "Zoe" }));
    await repo.addUserGame("user-1", "game-1", "Luna");
    await repo.addUserGame("user-1", "game-2", "Max");
    await repo.addUserGame("user-1", "game-3", "Zoe");

    const partnerId = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Co-parents",
    });
    await repo.linkGameToPartner("user-1", "game-1", partnerId);
    await repo.linkGameToPartner("user-1", "game-2", partnerId);

    const album = await repo.loadAlbum("user-1");
    expect(album.partners).toHaveLength(1);
    expect(album.partners[0].kids).toHaveLength(2);
    const kidNames = album.partners[0].kids.map((k) => k.childName).sort();
    expect(kidNames).toEqual(["Luna", "Max"]);
    expect(album.unlinkedKids).toHaveLength(1);
    expect(album.unlinkedKids[0].childName).toBe("Zoe");
  });

  it("loadScrapbook returns null for unknown games", async () => {
    const repo = new InMemoryGameRepository();
    const result = await repo.loadScrapbook("user-1", "nonexistent-game");
    expect(result).toBeNull();
  });

  it("loadScrapbook includes partner info when game is linked", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ id: "game-1" }));
    await repo.addUserGame("user-1", "game-1", "Luna");
    await repo.saveEndgame("game-1", "Luna grew up thoughtful.", "# Report Card");

    const partnerId = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Co-parents since 2020",
    });
    await repo.linkGameToPartner("user-1", "game-1", partnerId);

    const scrapbook = await repo.loadScrapbook("user-1", "game-1");
    expect(scrapbook).not.toBeNull();
    expect(scrapbook!.childName).toBe("Luna");
    expect(scrapbook!.partnerName).toBe("Alex");
    expect(scrapbook!.partnerType).toBe("real");
    expect(scrapbook!.relationshipSummary).toBe("Co-parents since 2020");
    expect(scrapbook!.epilogue).toBe("Luna grew up thoughtful.");
    expect(scrapbook!.reportCard).toBe("# Report Card");
  });

  it("loadScrapbook returns null partner fields when game is unlinked", async () => {
    const repo = new InMemoryGameRepository();
    await repo.saveGame(baseState({ id: "game-1" }));
    await repo.addUserGame("user-1", "game-1", "Luna");

    const scrapbook = await repo.loadScrapbook("user-1", "game-1");
    expect(scrapbook).not.toBeNull();
    expect(scrapbook!.partnerName).toBeNull();
    expect(scrapbook!.partnerType).toBeNull();
    expect(scrapbook!.relationshipSummary).toBeNull();
    expect(scrapbook!.epilogue).toBe("");
    expect(scrapbook!.reportCard).toBe("");
  });
});
