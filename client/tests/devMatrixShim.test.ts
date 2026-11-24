import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_MXID_KEY, devMatrixAuth, resolveDevMxid } from "../src/devMatrixShim.js";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

test("?devmxid= is remembered and wins over the stored id", () => {
  const s = memoryStorage();
  assert.equal(resolveDevMxid("?devmxid=@alice:local", s), "@alice:local");
  assert.equal(s.map.get(DEV_MXID_KEY), "@alice:local");
  assert.equal(resolveDevMxid("", s), "@alice:local");
  assert.equal(resolveDevMxid("?devmxid=%40bob%3Alocal", s), "@bob:local");
});

test("an empty or invalid ?devmxid= forgets it; nothing set means no shim", () => {
  const s = memoryStorage();
  assert.equal(resolveDevMxid("", s), null);
  resolveDevMxid("?devmxid=@alice:local", s);
  assert.equal(resolveDevMxid("?devmxid=", s), null);
  assert.equal(s.map.has(DEV_MXID_KEY), false);
  assert.equal(resolveDevMxid("?devmxid=alice", s), null);
  s.setItem(DEV_MXID_KEY, "not-an-id");
  assert.equal(resolveDevMxid("", s), null);
});

test("the fake client's OpenID token is dev:<mxid>", async () => {
  let loggedOut = false;
  const ma = devMatrixAuth("@alice:local", () => { loggedOut = true; });
  assert.equal(ma.isLoggedIn(), true);
  assert.equal(ma.getUserId(), "@alice:local");
  assert.equal((await ma.getOpenIdToken()).access_token, "dev:@alice:local");
  await ma.logout();
  assert.equal(ma.isLoggedIn(), false);
  assert.equal(ma.getUserId(), null);
  assert.equal(loggedOut, true);
});
