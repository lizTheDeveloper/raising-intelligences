import { test } from "node:test";
import assert from "node:assert/strict";
import { sendRepair } from "../src/repairClient.js";

type Call = { url: string; init?: RequestInit };

function fake(respond: () => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

test("posts the trimmed message with the secret header and returns true on 204", async () => {
  const { calls, fetchFn } = fake(() => new Response(null, { status: 204 }));
  const ok = await sendRepair({ gameId: "g 1", secret: "s3", message: "  I am sorry  ", base: "/", fetchFn });
  assert.equal(ok, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/game/g%201/repair");
  assert.equal(calls[0].init?.method, "POST");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-game-secret"], "s3");
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { message: "I am sorry" });
});

test("omits the secret header when the device has none", async () => {
  const { calls, fetchFn } = fake(() => new Response(null, { status: 204 }));
  assert.equal(await sendRepair({ gameId: "g", secret: null, message: "hi", base: "/", fetchFn }), "sent");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal("x-game-secret" in headers, false);
});

test("returns false, and does not throw, on an error status", async () => {
  for (const status of [400, 409, 500]) {
    const { fetchFn } = fake(() => new Response("{}", { status }));
    assert.equal(await sendRepair({ gameId: "g", secret: "s", message: "hi", base: "/", fetchFn }), "failed");
  }
});

test("returns false, and does not throw, when fetch rejects or throws", async () => {
  const rejecting = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.equal(await sendRepair({ gameId: "g", secret: "s", message: "hi", base: "/", fetchFn: rejecting }), "failed");
  const throwing = (() => { throw new Error("sync"); }) as unknown as typeof fetch;
  assert.equal(await sendRepair({ gameId: "g", secret: "s", message: "hi", base: "/", fetchFn: throwing }), "failed");
});

test("does not call the server for an empty or over-long message", async () => {
  const { calls, fetchFn } = fake(() => new Response(null, { status: 204 }));
  assert.equal(await sendRepair({ gameId: "g", secret: "s", message: "   ", base: "/", fetchFn }), "failed");
  assert.equal(await sendRepair({ gameId: "g", secret: "s", message: "a".repeat(1001), base: "/", fetchFn }), "failed");
  assert.equal(calls.length, 0);
});

test("a 403 (session ended on safety grounds) is reported as ended, not as a plain failure", async () => {
  const { fetchFn } = fake(() => new Response("{}", { status: 403 }));
  assert.equal(await sendRepair({ gameId: "g", secret: "s", message: "hi", base: "/", fetchFn }), "ended");
});

test("in a campus cabinet the identity token rides along as x-campus-identity", async () => {
  const { calls, fetchFn } = fake(() => new Response(null, { status: 204 }));
  await sendRepair({ gameId: "g", secret: null, campusIdentity: "ident-1", message: "hi", base: "/", fetchFn });
  assert.equal((calls[0].init?.headers as Record<string, string>)["x-campus-identity"], "ident-1");
  await sendRepair({ gameId: "g", secret: null, message: "hi", base: "/", fetchFn });
  assert.equal((calls[1].init?.headers as Record<string, string>)["x-campus-identity"], undefined);
});
