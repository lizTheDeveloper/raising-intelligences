import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOST_PASS_KEY,
  TOO_SMALL,
  asDeck,
  asPortalEvents,
  dateRange,
  formatDate,
  funnelLine,
  hostActions,
  hostRoute,
  gameAddress,
  deckPlayLines,
  loadHostPass,
  saveHostPass,
  showShareCodes,
  statusLabel,
  type HostEv,
} from "../src/hostPortal.js";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}
const throwing = () => {
  const boom = () => { throw new Error("blocked"); };
  return { getItem: boom, setItem: boom, removeItem: boom };
};

const NOV20 = Date.UTC(2026, 10, 20, 18, 0);
const NOV22 = Date.UTC(2026, 10, 22, 18, 0);

const host = (over: Partial<HostEv> = {}): HostEv => ({
  ref: "r1", role: "host", name: "parents night", level: 1, status: "open",
  opensAt: NOV20, closesAt: NOV22, shareCodes: false, ...over,
});

test("formatDate: lower-case month, day, year", () => {
  assert.equal(formatDate(NOV20, "UTC"), "november 20, 2026");
});

test("formatDate: local time decides the day", () => {
  const late = Date.UTC(2026, 10, 21, 2, 0); // the evening of the 20th in New York
  assert.equal(formatDate(late, "America/New_York"), "november 20, 2026");
  assert.equal(formatDate(late, "UTC"), "november 21, 2026");
});

test("dateRange: one date for a one-day meetup, two otherwise", () => {
  assert.equal(dateRange(NOV20, NOV20 + 3_600_000, "UTC"), "november 20, 2026");
  assert.equal(dateRange(NOV20, NOV22, "UTC"), "november 20, 2026 – november 22, 2026");
});

test("statusLabel reads not_open_yet as words", () => {
  assert.equal(statusLabel("not_open_yet"), "not open yet");
  assert.equal(statusLabel("paused"), "paused");
});

test("funnelLine: nothing when absent or not published", () => {
  assert.equal(funnelLine(undefined), null);
  assert.equal(funnelLine(null), null);
});

test("funnelLine: too small", () => {
  assert.equal(funnelLine({ tooSmall: true }), TOO_SMALL);
  assert.equal(TOO_SMALL, "this meetup was too small to show numbers.");
});

test("funnelLine: bands and proportions, swapped only when the exchange was on", () => {
  assert.equal(
    funnelLine({ tooSmall: false, joined: "10–19", started: "5–9", finished: "not shown at this size", swapped: null }),
    "joined the queue: 10–19 · games started: 5–9 · games finished: not shown at this size",
  );
  assert.equal(
    funnelLine({ tooSmall: false, joined: "20–49", started: "10–19", finished: "more than half", swapped: "half or fewer" }),
    "joined the queue: 20–49 · games started: 10–19 · games finished: more than half · pairs who swapped handles: half or fewer",
  );
});

test("hostActions: pause or resume, close, lower only above level 0, nothing once closed", () => {
  assert.deepEqual(hostActions(host()), { toggle: "pause", close: true, lower: true });
  assert.deepEqual(hostActions(host({ status: "paused" })), { toggle: "resume", close: true, lower: true });
  assert.deepEqual(hostActions(host({ level: 0, status: "full" })), { toggle: "pause", close: true, lower: false });
  assert.deepEqual(hostActions(host({ status: "closed", level: 3 })), { toggle: null, close: false, lower: false });
});

test("showShareCodes: a code event hosted, or a guest anywhere", () => {
  assert.equal(showShareCodes([]), false);
  assert.equal(showShareCodes([host()]), false);
  assert.equal(showShareCodes([host(), host({ ref: "r2", shareCodes: true })]), true);
  assert.equal(showShareCodes([{ ref: "g", role: "guest", name: "x", opensAt: NOV20, closesAt: NOV22 }]), true);
});

test("asPortalEvents: host and guest entries, funnel absent / null / published", () => {
  const body = {
    displayName: "sam",
    events: [
      { ref: "a", role: "host", name: "one", level: 0, status: "open", opensAt: NOV20, closesAt: NOV22, shareCodes: false },
      { ref: "b", role: "host", name: "two", level: 1, status: "closed", opensAt: NOV20, closesAt: NOV22, shareCodes: false, funnel: null },
      { ref: "c", role: "host", name: "three", level: 3, status: "closed", opensAt: NOV20, closesAt: NOV22, shareCodes: true, funnel: { tooSmall: true } },
      { ref: "d", role: "guest", name: "four", opensAt: NOV20, closesAt: NOV22, level: 3, funnel: { tooSmall: true } },
    ],
  };
  const r = asPortalEvents(body);
  assert.ok(r);
  assert.equal(r.displayName, "sam");
  assert.equal(r.events.length, 4);
  assert.equal("funnel" in r.events[0], false);
  assert.equal((r.events[1] as HostEv).funnel, null);
  assert.deepEqual((r.events[2] as HostEv).funnel, { tooSmall: true });
  // A guest entry keeps only name and dates, whatever else arrives.
  assert.deepEqual(r.events[3], { ref: "d", role: "guest", name: "four", opensAt: NOV20, closesAt: NOV22 });
});

test("asPortalEvents: malformed entries are dropped, not guessed at", () => {
  const r = asPortalEvents({
    displayName: "sam",
    events: [
      { ref: "a", role: "host", name: "bad status", level: 1, status: "live", opensAt: NOV20, closesAt: NOV22 },
      { ref: "b", role: "host", name: "bad funnel", level: 1, status: "closed", opensAt: NOV20, closesAt: NOV22, funnel: { tooSmall: false, joined: 7 } },
      { ref: "c", role: "admin", name: "bad role", opensAt: NOV20, closesAt: NOV22 },
      { ref: "", role: "guest", name: "no ref", opensAt: NOV20, closesAt: NOV22 },
      { ref: "e", role: "guest", name: "ok", opensAt: NOV20, closesAt: NOV22 },
    ],
  });
  assert.deepEqual(r?.events.map((e) => e.ref), ["e"]);
  assert.equal(asPortalEvents(null), null);
  assert.equal(asPortalEvents({ error: "Not signed in." }), null);
});

test("asDeck: the deck, or null", () => {
  const deck = { title: "t", intro: "i", questions: ["q1", "q2"] };
  assert.deepEqual(asDeck({ deck }), deck);
  assert.equal(asDeck(null), null);
  assert.equal(asDeck({}), null);
  assert.equal(asDeck({ deck: { title: "t", intro: "i", questions: [] } }), null);
  assert.equal(asDeck({ deck: { title: "t", intro: "i", questions: [1] } }), null);
  assert.equal(asDeck("<!doctype html>"), null);
});

test("host pass: kept in session storage, cleared, and blocked storage is survivable", () => {
  const s = memoryStorage();
  assert.equal(loadHostPass(s), null);
  saveHostPass("p1", s);
  assert.equal(s.map.get(HOST_PASS_KEY), "p1");
  assert.equal(loadHostPass(s), "p1");
  saveHostPass(null, s);
  assert.equal(loadHostPass(s), null);
  assert.equal(HOST_PASS_KEY, "ri_host_pass");
  const t = throwing();
  assert.doesNotThrow(() => saveHostPass("p", t));
  assert.equal(loadHostPass(t), null);
  assert.equal(loadHostPass(null), null);
});

test("the deck's printout says where the game is and how two people start (Marisol)", () => {
  assert.equal(gameAddress("https://multiversegames.ai", "/raising-intelligences/"), "multiversegames.ai/raising-intelligences");
  assert.equal(gameAddress("http://localhost:5173", "/"), "localhost:5173");
  const lines = deckPlayLines("multiversegames.ai/raising-intelligences");
  assert.equal(lines.heading, "to play");
  assert.deepEqual(lines.steps, [
    "open multiversegames.ai/raising-intelligences on a phone or laptop.",
    "to play together, choose \"play with a partner\" and send the other person the link it gives you. to play alone, choose \"play solo\".",
  ]);
});

test("hostRoute: ?host=1 and ?deck=1 only", () => {
  assert.equal(hostRoute("?host=1"), "host");
  assert.equal(hostRoute("?deck=1"), "deck");
  assert.equal(hostRoute("?host=1&deck=1"), "host");
  assert.equal(hostRoute("?host=0"), null);
  assert.equal(hostRoute("?host"), null);
  assert.equal(hostRoute(""), null);
});
