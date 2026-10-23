import { test } from "node:test";
import assert from "node:assert/strict";
import { readMemorySummary } from "../src/memorySummary.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("returns the summary text", async () => {
  const f = (async () => json({ memorySummary: "I remember." })) as unknown as typeof fetch;
  assert.equal(await readMemorySummary("/s", f, 50), "I remember.");
});

test("a game with no summary field reads as empty, not failure", async () => {
  const f = (async () => json({})) as unknown as typeof fetch;
  assert.equal(await readMemorySummary("/s", f, 50), "");
});

test("a fetch that never resolves times out to null without throwing", async () => {
  let aborted = false;
  const f = ((_u: string, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => (aborted = true));
    return new Promise(() => {});
  }) as unknown as typeof fetch;
  const started = Date.now();
  assert.equal(await readMemorySummary("/s", f, 30), null);
  assert.ok(Date.now() - started < 1000);
  assert.ok(aborted);
});

test("non-ok, rejected and synchronously throwing fetches give null", async () => {
  assert.equal(await readMemorySummary("/s", (async () => json({}, 500)) as unknown as typeof fetch, 50), null);
  assert.equal(await readMemorySummary("/s", (async () => { throw new Error("x"); }) as unknown as typeof fetch, 50), null);
  assert.equal(await readMemorySummary("/s", (() => { throw new Error("x"); }) as unknown as typeof fetch, 50), null);
});
