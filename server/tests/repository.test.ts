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
    };
    const m2: Message = {
      sender: "kid",
      content: "I didn't mean to!",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 200,
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
    await repo.saveGame(baseState({ phase: "family_chat" }));
    await repo.saveMessage("game-1", {
      sender: "parent1",
      content: "a",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 1,
    });
    await repo.saveMessage("game-1", {
      sender: "kid",
      content: "b",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 2,
    });
    await repo.saveMessage("game-1", {
      sender: "parent2",
      content: "c",
      chatType: "shared",
      visibleTo: ["parent1", "parent2", "kid"],
      timestamp: 3,
    });

    const loaded = await repo.loadGame("game-1");
    expect(loaded!.parentMessageCount).toBe(2);
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
