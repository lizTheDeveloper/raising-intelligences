import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAMPUS_ORIGIN,
  CampusCabinet,
  campusIdentity,
  campusIdentityUnknown,
  campusPassUrl,
  isCabinetActive,
  isCabinetMode,
  setActiveCabinet,
} from "../src/campusCabinet.js";

const ORIGIN = "https://play.multiversegames.ai";
const BASE = "/raising-intelligences/";

type Posted = { msg: unknown; target: string };

function fakeWindow(opts: { framed?: boolean; search?: string; pathname?: string; storageBlocked?: boolean } = {}) {
  const posted: Posted[] = [];
  const listeners: Array<(e: MessageEvent) => void> = [];
  const store = new Map<string, string>();
  const boom = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  const parent = { postMessage: (msg: unknown, target: string) => posted.push({ msg, target }) };
  const win: Record<string, unknown> = {
    location: { search: opts.search ?? "?cabinet=campus", origin: ORIGIN, pathname: opts.pathname ?? BASE },
    parent,
    addEventListener: (type: string, fn: (e: MessageEvent) => void) => {
      if (type === "message") listeners.push(fn);
    },
    sessionStorage: opts.storageBlocked
      ? { getItem: boom, setItem: boom, removeItem: boom }
      : {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
        },
  };
  win.self = win;
  win.top = opts.framed === false ? win : {};
  const deliver = (data: unknown, origin = CAMPUS_ORIGIN, source: unknown = parent) =>
    listeners.forEach((l) => l({ data, origin, source } as MessageEvent));
  return { win: win as unknown as Window, posted, deliver, store };
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ok = () => new Response(JSON.stringify({ identity: "ident-1", name: "Synthetic Student", sub: "@s:themultiverse.school" }), { status: 200 });
const flush = () => new Promise((r) => setTimeout(r, 0));

test("cabinet mode needs both a frame and ?cabinet=campus", () => {
  assert.equal(isCabinetMode(fakeWindow().win), true);
  assert.equal(isCabinetMode(fakeWindow({ framed: false }).win), false);
  assert.equal(isCabinetMode(fakeWindow({ search: "" }).win), false);
  assert.equal(isCabinetMode(fakeWindow({ search: "?cabinet=other" }).win), false);
});

test("outside cabinet mode nothing happens: no message, no fetch, no identity", async () => {
  const w = fakeWindow({ framed: false });
  const f = fakeFetch(ok);
  const c = new CampusCabinet({ win: w.win, base: BASE, fetchImpl: f.fetchImpl });
  c.start();
  w.deliver({ type: "mg:pass", v: 1, pass: "cps.a.b" });
  await flush();
  assert.equal(w.posted.length, 0);
  assert.equal(f.calls.length, 0);
  setActiveCabinet(c);
  assert.equal(isCabinetActive(), false);
  assert.equal(campusIdentity(), undefined);
  setActiveCabinet(null);
});

test("boot posts mg:ready to the campus origin only; a pass is exchanged, kept, and mg:signed-in posted", async () => {
  const w = fakeWindow();
  const f = fakeFetch(ok);
  const c = new CampusCabinet({ win: w.win, base: BASE, fetchImpl: f.fetchImpl });
  c.start();
  assert.deepEqual(w.posted, [{ msg: { type: "mg:ready", v: 1, game: "raising-intelligences" }, target: CAMPUS_ORIGIN }]);
  w.deliver({ type: "mg:pass", v: 1, pass: "cps.synthetic.pass" });
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${ORIGIN}/raising-intelligences/api/campus-pass`);
  assert.equal(f.calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(f.calls[0].init?.body as string), { pass: "cps.synthetic.pass" });
  assert.equal(c.identity, "ident-1");
  assert.deepEqual(w.posted.at(-1), { msg: { type: "mg:signed-in", v: 1, game: "raising-intelligences" }, target: CAMPUS_ORIGIN });
  // The identity, never the pass, is what gets remembered.
  const stored = [...w.store.values()].join("");
  assert.ok(stored.includes("ident-1"));
  assert.ok(!stored.includes("cps.synthetic.pass"));

  setActiveCabinet(c);
  assert.equal(isCabinetActive(), true);
  assert.equal(campusIdentity(), "ident-1");
  setActiveCabinet(null);
});

test("messages from another origin, another source, or of the wrong shape are ignored", async () => {
  const w = fakeWindow();
  const f = fakeFetch(ok);
  const c = new CampusCabinet({ win: w.win, base: BASE, fetchImpl: f.fetchImpl });
  c.start();
  w.deliver({ type: "mg:pass", v: 1, pass: "cps.x.y" }, "https://evil.example");
  w.deliver({ type: "mg:pass", v: 1, pass: "cps.x.y" }, CAMPUS_ORIGIN, {});
  w.deliver({ type: "mg:pass", v: 2, pass: "cps.x.y" });
  w.deliver({ type: "mg:pass", v: 1, pass: 5 });
  w.deliver("mg:pass");
  await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(c.identity, null);
});

test("a //evil.example/x pathname never sends the pass off the page's origin", async () => {
  const w = fakeWindow({ pathname: "//evil.example/x" });
  const f = fakeFetch(ok);
  const c = new CampusCabinet({ win: w.win, base: BASE, fetchImpl: f.fetchImpl });
  c.start();
  w.deliver({ type: "mg:pass", v: 1, pass: "cps.synthetic.pass" });
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(new URL(f.calls[0].url).origin, ORIGIN);
  assert.ok(!f.calls[0].url.includes("evil.example"));
});

test("campusPassUrl stays on the origin whatever the base looks like", () => {
  assert.equal(campusPassUrl(ORIGIN, "/"), `${ORIGIN}/api/campus-pass`);
  assert.equal(campusPassUrl(ORIGIN, BASE), `${ORIGIN}/raising-intelligences/api/campus-pass`);
  for (const base of ["//evil.example/x", "//evil.example/", "\\\\evil.example/", "/\\evil.example/", "https://evil.example/"]) {
    const u = campusPassUrl(ORIGIN, base);
    assert.ok(u === null || new URL(u).origin === ORIGIN, `${base} → ${u}`);
  }
});

test("a refused pass or a network error leaves play anonymous", async () => {
  for (const respond of [() => new Response(JSON.stringify({ error: "pass_refused" }), { status: 400 }), () => Promise.reject(new Error("offline"))]) {
    const w = fakeWindow();
    const f = fakeFetch(respond);
    const c = new CampusCabinet({ win: w.win, base: BASE, fetchImpl: f.fetchImpl });
    c.start();
    w.deliver({ type: "mg:pass", v: 1, pass: "cps.a.b" });
    await flush();
    assert.equal(c.identity, null);
    assert.ok(!w.posted.some((p) => (p.msg as { type: string }).type === "mg:signed-in"));
  }
});

test("an identity the server doesn't know triggers one re-ask per minute at most", async () => {
  let now = 1_000_000;
  const w = fakeWindow();
  const f = fakeFetch(ok);
  const c = new CampusCabinet({ win: w.win, base: BASE, fetchImpl: f.fetchImpl, now: () => now });
  setActiveCabinet(c);
  c.start();
  w.deliver({ type: "mg:pass", v: 1, pass: "cps.a.b" });
  await flush();
  const readies = () => w.posted.filter((p) => (p.msg as { type: string }).type === "mg:ready").length;
  assert.equal(readies(), 1);
  now += 10_000;
  campusIdentityUnknown();
  assert.equal(c.identity, null);
  assert.equal(campusIdentity(), undefined);
  assert.equal(readies(), 1, "too soon after boot's mg:ready");
  now += 60_000;
  campusIdentityUnknown();
  assert.equal(readies(), 2);
  campusIdentityUnknown();
  assert.equal(readies(), 2, "no loop");
  setActiveCabinet(null);
});

test("a reload restores the identity from sessionStorage; blocked storage doesn't crash", async () => {
  const w = fakeWindow();
  const f = fakeFetch(ok);
  new CampusCabinet({ win: w.win, base: BASE, fetchImpl: f.fetchImpl }).start();
  w.deliver({ type: "mg:pass", v: 1, pass: "cps.a.b" });
  await flush();
  const again = new CampusCabinet({ win: w.win, base: BASE, fetchImpl: f.fetchImpl });
  again.start();
  assert.equal(again.identity, "ident-1");

  const blocked = fakeWindow({ storageBlocked: true });
  const c = new CampusCabinet({ win: blocked.win, base: BASE, fetchImpl: fakeFetch(ok).fetchImpl });
  assert.doesNotThrow(() => c.start());
  blocked.deliver({ type: "mg:pass", v: 1, pass: "cps.a.b" });
  await flush();
  assert.equal(c.identity, "ident-1");
  assert.doesNotThrow(() => c.identityUnknown());
});
