import { test } from "node:test";
import assert from "node:assert/strict";
import { createWaitSession } from "../src/researchClient.js";
import type { Question } from "../src/researchTypes.js";

const q1: Question = {
  id: "a",
  version: 1,
  kind: "about_you",
  prompt: "p1",
  waits: ["first"],
  answer: { type: "tap", options: [{ value: "x", label: "X" }] },
};
const q2: Question = { ...q1, id: "b", prompt: "p2" };

type Call = { url: string; init?: RequestInit };

function setup(opts: { respond?: (c: Call) => Promise<Response> | Response; sceneIndex?: number } = {}) {
  const calls: Call[] = [];
  const shown: Array<Question | null> = [];
  const events: Array<[string, unknown]> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    if (init?.method === "POST") return new Response(null, { status: 204 });
    return opts.respond ? opts.respond(c) : new Response(JSON.stringify({ questions: [q1, q2] }), { status: 200 });
  }) as unknown as typeof fetch;
  const session = createWaitSession({
    gameId: "g1",
    secret: "s3",
    wait: "post_scene",
    sceneIndex: opts.sceneIndex ?? 4,
    base: "/",
    fetchFn,
    now: () => 1234,
    onCurrent: (q) => shown.push(q),
    onEvent: (e, p) => events.push([e, p]),
  });
  return { session, calls, shown, events };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const posts = (calls: Call[]) => calls.filter((c) => c.init?.method === "POST");

test("start requests the questions with the secret and scene", async () => {
  const { session, calls, shown } = setup();
  session.start();
  await tick();
  assert.equal(calls[0]!.url, "/api/game/g1/questions?wait=post_scene&sceneIndex=4");
  assert.deepEqual(calls[0]!.init?.headers, { "x-game-secret": "s3" });
  assert.equal(shown[0]?.id, "a");
});

test("skip posts skipped:true and then serves the next card", async () => {
  const { session, calls, shown, events } = setup();
  session.start();
  await tick();
  session.skip();
  const body = JSON.parse(posts(calls)[0]!.init!.body as string);
  assert.deepEqual(body, { questionId: "a", version: 1, sceneIndex: 4, shownAt: 1234, skipped: true });
  assert.equal(shown.at(-1)?.id, "b");
  assert.deepEqual(events.map((e) => e[0]), ["wait_question_shown", "wait_question_skipped", "wait_question_shown"]);
  assert.deepEqual(events[1]![1], { questionId: "a", wait: "post_scene" });
});

test("submit posts the answer with the scene the card was shown in", async () => {
  const { session, calls } = setup({ sceneIndex: 2 });
  session.start();
  await tick();
  session.submit("x");
  const body = JSON.parse(posts(calls)[0]!.init!.body as string);
  assert.equal(body.sceneIndex, 2);
  assert.equal(body.answer, "x");
  assert.equal(body.skipped, undefined);
  assert.equal(posts(calls)[0]!.init!.method, "POST");
});

test("a double submit posts once per card", async () => {
  const { session, calls } = setup({ respond: () => new Response(JSON.stringify({ questions: [q1] }), { status: 200 }) });
  session.start();
  await tick();
  session.submit("x");
  session.submit("x");
  session.skip();
  assert.equal(posts(calls).length, 1);
});

test("a response arriving after dispose never shows a card", async () => {
  let release!: (r: Response) => void;
  const { session, shown } = setup({ respond: () => new Promise<Response>((r) => (release = r)) });
  session.start();
  session.dispose();
  release(new Response(JSON.stringify({ questions: [q1] }), { status: 200 }));
  await tick();
  assert.deepEqual(shown, []);
});

test("submit and skip after dispose post nothing", async () => {
  const { session, calls } = setup();
  session.start();
  await tick();
  session.dispose();
  session.submit("x");
  session.skip();
  assert.equal(posts(calls).length, 0);
});

test("non-200 yields no card", async () => {
  for (const status of [403, 404, 500]) {
    const { session, shown } = setup({ respond: () => new Response("{}", { status }) });
    session.start();
    await tick();
    assert.deepEqual(shown, []);
  }
});

test("a fetch that rejects or throws yields no card and no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  for (const respond of [
    () => Promise.reject(new Error("net")),
    () => {
      throw new Error("sync");
    },
  ]) {
    const { session, shown } = setup({ respond });
    session.start();
    await tick();
    assert.deepEqual(shown, []);
  }
  // Failing POST is swallowed too.
  const shown: unknown[] = [];
  const session = createWaitSession({
    gameId: "g",
    secret: "s",
    wait: "first",
    sceneIndex: 0,
    base: "/",
    fetchFn: (async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("post failed");
      return new Response(JSON.stringify({ questions: [q1] }), { status: 200 });
    }) as unknown as typeof fetch,
    now: () => 1,
    onCurrent: (q) => shown.push(q),
    onEvent: () => {},
  });
  session.start();
  await tick();
  session.skip();
  await tick();
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
});

test("malformed questions are dropped", async () => {
  const { session, shown } = setup({
    respond: () => new Response(JSON.stringify({ questions: [{ id: 1 }, null, q1] }), { status: 200 }),
  });
  session.start();
  await tick();
  assert.equal(shown[0]?.id, "a");
});
