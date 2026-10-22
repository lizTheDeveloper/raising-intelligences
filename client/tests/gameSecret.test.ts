import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { saveGameSecret, getGameSecret } from "../src/hooks/gameSecret.js";

const g = globalThis as { localStorage?: unknown };
const original = g.localStorage;
afterEach(() => {
  if (original === undefined) delete g.localStorage;
  else g.localStorage = original;
});

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    keys: () => [...m.keys()],
  };
}

test("round-trips a secret under ri_game_secret:<gameId>", () => {
  const store = memoryStorage();
  g.localStorage = store;
  saveGameSecret("abc", "s3cret");
  assert.equal(getGameSecret("abc"), "s3cret");
  assert.deepEqual(store.keys(), ["ri_game_secret:abc"]);
  assert.equal(getGameSecret("other"), null);
});

test("does not throw and returns null when localStorage throws", () => {
  const boom = () => {
    throw new Error("blocked");
  };
  g.localStorage = { getItem: boom, setItem: boom };
  assert.doesNotThrow(() => saveGameSecret("abc", "x"));
  assert.equal(getGameSecret("abc"), null);
});

test("does not throw and returns null when localStorage is absent", () => {
  delete g.localStorage;
  assert.doesNotThrow(() => saveGameSecret("abc", "x"));
  assert.equal(getGameSecret("abc"), null);
});
