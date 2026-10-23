import { test } from "node:test";
import assert from "node:assert/strict";
import { saveFollowup, withdrawFollowup, looksLikeEmail } from "../src/followupClient.js";

type Call = { url: string; init?: RequestInit };

function fake(status: number | "throw") {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (status === "throw") throw new Error("network");
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const base = { gameId: "g 1", secret: "s3", base: "/" };

test("saveFollowup sends the secret header and exactly the three fields", async () => {
  const f = fake(204);
  const r = await saveFollowup({ ...base, fetchFn: f.fetchFn, email: "a@b.com" });
  assert.equal(r, "saved");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/api/research/followup/g%201");
  assert.equal(f.calls[0].init?.method, "POST");
  const headers = f.calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-game-secret"], "s3");
  assert.deepEqual(JSON.parse(String(f.calls[0].init?.body)), {
    email: "a@b.com",
    consentFollowup: true,
    consentAiAnalysis: true,
  });
});

test("saveFollowup maps statuses: 403/404 unavailable, others failed, throw failed", async () => {
  assert.equal(await saveFollowup({ ...base, fetchFn: fake(403).fetchFn, email: "a@b.com" }), "unavailable");
  assert.equal(await saveFollowup({ ...base, fetchFn: fake(404).fetchFn, email: "a@b.com" }), "unavailable");
  assert.equal(await saveFollowup({ ...base, fetchFn: fake(400).fetchFn, email: "a@b.com" }), "failed");
  assert.equal(await saveFollowup({ ...base, fetchFn: fake(500).fetchFn, email: "a@b.com" }), "failed");
  assert.equal(await saveFollowup({ ...base, fetchFn: fake(429).fetchFn, email: "a@b.com" }), "failed");
  assert.equal(await saveFollowup({ ...base, fetchFn: fake("throw").fetchFn, email: "a@b.com" }), "failed");
});

test("a fetchFn that throws synchronously never throws out", async () => {
  const fetchFn = (() => { throw new Error("sync"); }) as unknown as typeof fetch;
  assert.equal(await saveFollowup({ ...base, fetchFn, email: "a@b.com" }), "failed");
  assert.equal(await withdrawFollowup({ ...base, fetchFn }), "failed");
});

test("no secret means no request", async () => {
  const f = fake(204);
  assert.equal(await saveFollowup({ ...base, secret: null, fetchFn: f.fetchFn, email: "a@b.com" }), "unavailable");
  assert.equal(await withdrawFollowup({ ...base, secret: "", fetchFn: f.fetchFn }), "unavailable");
  assert.equal(f.calls.length, 0);
});

test("withdrawFollowup sends DELETE with the secret and no body", async () => {
  const f = fake(204);
  assert.equal(await withdrawFollowup({ ...base, fetchFn: f.fetchFn }), "saved");
  assert.equal(f.calls[0].init?.method, "DELETE");
  assert.equal((f.calls[0].init?.headers as Record<string, string>)["x-game-secret"], "s3");
  assert.equal(f.calls[0].init?.body, undefined);
});

test("looksLikeEmail is a light check", () => {
  for (const ok of ["a@b.co", " a.b+c@d.example.com "]) assert.equal(looksLikeEmail(ok), true, ok);
  for (const bad of ["", "a", "a@b", "a@@b.co", "a b@c.co", "@b.co", "a@.co", "a@b."]) assert.equal(looksLikeEmail(bad), false, bad);
});
