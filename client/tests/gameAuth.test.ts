// Privacy review F1: every read of a game sends the reader's own credential.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { gameReadHeaders, kidsWithProof, matrixAuthHeaders, resetMatrixTokenCache } from "../src/gameAuth.js";

const matrix = (user: string | null, token = "oid-1") => {
  let calls = 0;
  return {
    calls: () => calls,
    isLoggedIn: () => user !== null,
    getUserId: () => user,
    getOpenIdToken: async () => {
      calls++;
      return { access_token: token, token_type: "Bearer", matrix_server_name: "multiversegames.ai", expires_in: 3600 };
    },
  };
};

beforeEach(() => resetMatrixTokenCache());

test("a solo game reads with its secret", async () => {
  const h = await gameReadHeaders("g1", { getSecret: (id) => (id === "g1" ? "sec" : null), loadResume: () => null, matrix: undefined });
  assert.deepEqual(h, { "x-game-secret": "sec" });
});

test("a seated game reads with this player's seat token", async () => {
  const h = await gameReadHeaders("g2", { getSecret: () => null, loadResume: () => ({ gameId: "g2", playerToken: "pt" }), matrix: undefined });
  assert.deepEqual(h, { "x-player-token": "pt" });
});

test("another game's seat token is never sent", async () => {
  const h = await gameReadHeaders("g3", { getSecret: () => null, loadResume: () => ({ gameId: "g2", playerToken: "pt" }), matrix: undefined });
  assert.deepEqual(h, {});
});

test("with nothing local, a signed-in player reads by their Matrix sign-in (another device)", async () => {
  const m = matrix("@a:multiversegames.ai");
  const h = await gameReadHeaders("g4", { getSecret: () => null, loadResume: () => null, matrix: m });
  assert.deepEqual(h, { "x-matrix-openid": "oid-1" });
});

test("the OpenID token is fetched once and reused until near expiry", async () => {
  const m = matrix("@a:multiversegames.ai");
  await matrixAuthHeaders(m);
  await matrixAuthHeaders(m);
  assert.equal(m.calls(), 1);
});

test("signed out, or no sign-in script: no Matrix header and no throw", async () => {
  assert.deepEqual(await matrixAuthHeaders(matrix(null)), {});
  assert.deepEqual(await matrixAuthHeaders(undefined), {});
  const broken = { isLoggedIn: () => true, getUserId: () => "@a:b.c", getOpenIdToken: async () => { throw new Error("offline"); } };
  assert.deepEqual(await matrixAuthHeaders(broken), {});
});

test("kids sync carries proof of each game this device can prove", () => {
  const out = kidsWithProof(
    [
      { gameId: "solo", childName: "A", createdAt: 1 },
      { gameId: "seat", childName: "B", createdAt: 2 },
      { gameId: "none", childName: "C", createdAt: 3 },
    ],
    (id) => (id === "solo" ? "sec" : null),
    { gameId: "seat", playerToken: "pt" },
  );
  assert.deepEqual(out, [
    { gameId: "solo", childName: "A", secret: "sec" },
    { gameId: "seat", childName: "B", playerToken: "pt" },
    { gameId: "none", childName: "C" },
  ]);
});
