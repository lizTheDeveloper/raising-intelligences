import { describe, it, expect } from "vitest";
import {
  createSession,
  addPlayer,
  removePlayer,
  disconnectPlayer,
  reconnectPlayer,
  getPlayerByToken,
  setReady,
  setDisplayName,
  allReady,
  resetReady,
  isFull,
  getPlayer,
} from "../src/game/session-manager.js";

describe("session-manager", () => {
  it("assigns parent1 then parent2", () => {
    let s = createSession("g1");
    const a = addPlayer(s, "conn-a");
    s = a.session;
    expect(a.player.slot).toBe("parent1");
    const b = addPlayer(s, "conn-b");
    s = b.session;
    expect(b.player.slot).toBe("parent2");
    expect(isFull(s)).toBe(true);
  });

  it("rejects a third distinct player", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    s = addPlayer(s, "b").session;
    expect(() => addPlayer(s, "c")).toThrow(/full/i);
  });

  it("is idempotent for an existing connection", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    const again = addPlayer(s, "a");
    expect(again.player.slot).toBe("parent1");
    expect(again.session.players).toHaveLength(1);
  });

  it("frees a slot on removal and reassigns it", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    s = addPlayer(s, "b").session;
    s = removePlayer(s, "a");
    expect(getPlayer(s, "a")).toBeUndefined();
    const c = addPlayer(s, "c");
    expect(c.player.slot).toBe("parent1");
  });

  it("allReady is true only when both slots are filled and ready", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    s = setReady(s, "a", true);
    expect(allReady(s)).toBe(false); // only one player
    s = addPlayer(s, "b").session;
    expect(allReady(s)).toBe(false); // b not ready
    s = setReady(s, "b", true);
    expect(allReady(s)).toBe(true);
  });

  it("resetReady clears all ready flags", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    s = addPlayer(s, "b").session;
    s = setReady(s, "a", true);
    s = setReady(s, "b", true);
    s = resetReady(s);
    expect(allReady(s)).toBe(false);
    expect(s.players.every((p) => !p.ready)).toBe(true);
  });

  it("reclaims a disconnected slot for a new player", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    s = addPlayer(s, "b").session;
    s = disconnectPlayer(s, "b");
    // New player takes over the disconnected slot
    const c = addPlayer(s, "c", "New Parent");
    expect(c.player.slot).toBe("parent2");
    expect(c.player.displayName).toBe("New Parent");
    expect(c.player.connected).toBe(true);
    expect(c.session.players).toHaveLength(2);
    // Old player's connection is gone
    expect(getPlayer(c.session, "b")).toBeUndefined();
  });

  it("still rejects a third player when both are connected", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    s = addPlayer(s, "b").session;
    expect(() => addPlayer(s, "c")).toThrow(/full/i);
  });

  it("reconnects via token and restores slot", () => {
    let s = createSession("g1");
    const a = addPlayer(s, "a");
    s = a.session;
    s = addPlayer(s, "b").session;
    s = disconnectPlayer(s, "a");
    expect(getPlayer(s, "a")!.connected).toBe(false);
    const found = getPlayerByToken(s, a.player.token);
    expect(found).toBeDefined();
    expect(found!.connected).toBe(false);
    const reconnected = reconnectPlayer(s, a.player.token, "a2");
    expect(reconnected.player.slot).toBe("parent1");
    expect(reconnected.player.connected).toBe(true);
    expect(getPlayer(reconnected.session, "a2")!.slot).toBe("parent1");
  });

  it("allReady requires both connected", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    s = addPlayer(s, "b").session;
    s = setReady(s, "a", true);
    s = setReady(s, "b", true);
    expect(allReady(s)).toBe(true);
    s = disconnectPlayer(s, "b");
    expect(allReady(s)).toBe(false);
  });

  it("sets display name, falling back to default when blank", () => {
    let s = createSession("g1");
    s = addPlayer(s, "a").session;
    expect(getPlayer(s, "a")!.displayName).toBe("Parent 1");
    s = setDisplayName(s, "a", "Alex");
    expect(getPlayer(s, "a")!.displayName).toBe("Alex");
    s = setDisplayName(s, "a", "   ");
    expect(getPlayer(s, "a")!.displayName).toBe("Alex"); // unchanged on blank
  });
});
