import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearResume, getSavedKids, loadResume, mergeKids, saveKid, saveResume } from "../src/localStore.js";

// A campus cabinet is a cross-site iframe: browsers that block third-party
// storage make every localStorage call throw. Nothing here may crash the game.
function blockStorage() {
  const boom = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: boom, setItem: boom, removeItem: boom };
}

function memoryStorage() {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

beforeEach(() => memoryStorage());

test("saved kids and the resume credential round-trip", () => {
  saveKid("g1", "Testkid");
  assert.equal(getSavedKids()[0].gameId, "g1");
  const merged = mergeKids(getSavedKids(), [{ gameId: "g2", childName: "Otherkid", createdAt: 1 }]);
  assert.deepEqual(merged.map((k) => k.gameId), ["g1", "g2"]);
  saveResume("g1", "tok");
  assert.deepEqual(loadResume(), { gameId: "g1", playerToken: "tok" });
  clearResume();
  assert.equal(loadResume(), null);
});

test("with storage blocked, nothing throws", () => {
  blockStorage();
  assert.deepEqual(getSavedKids(), []);
  assert.doesNotThrow(() => saveKid("g1", "Testkid"));
  assert.doesNotThrow(() => mergeKids([], [{ gameId: "g2", childName: "Otherkid", createdAt: 1 }]));
  assert.deepEqual(mergeKids([], [{ gameId: "g2", childName: "Otherkid", createdAt: 1 }]).map((k) => k.gameId), ["g2"]);
  assert.doesNotThrow(() => saveResume("g1", "tok"));
  assert.doesNotThrow(() => clearResume());
  assert.equal(loadResume(), null);
});
