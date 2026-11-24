import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACK_KEY,
  ackBody,
  asCard,
  boldRuns,
  clearAck,
  currentStrangerPass,
  loadAck,
  lowerLevel,
  safeHttpsUrl,
  saveAck,
  statusNote,
  urlWithoutMeetup,
} from "../src/meetupCard.js";

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

// ---- **bold** ----

test("boldRuns: **x** becomes a bold run, the rest plain", () => {
  assert.deepEqual(boldRuns("you two give them a **share code**. ok"), [
    { text: "you two give them a ", bold: false },
    { text: "share code", bold: true },
    { text: ". ok", bold: false },
  ]);
});

test("boldRuns: HTML stays literal text (rendered as escaped React text)", () => {
  const runs = boldRuns("<img src=x onerror=alert(1)> **<b>hi</b>** <script>");
  assert.deepEqual(runs, [
    { text: "<img src=x onerror=alert(1)> ", bold: false },
    { text: "<b>hi</b>", bold: true },
    { text: " <script>", bold: false },
  ]);
  // Nothing is ever parsed out of the text: joining the runs gives back the input minus the markers.
  assert.equal(runs.map((r) => r.text).join(""), "<img src=x onerror=alert(1)> <b>hi</b> <script>");
});

test("boldRuns: an unpaired ** and an empty **** stay as written", () => {
  assert.deepEqual(boldRuns("a ** b"), [{ text: "a ** b", bold: false }]);
  assert.deepEqual(boldRuns("a **** b"), [{ text: "a **** b", bold: false }]);
  assert.deepEqual(boldRuns("**a** and **b"), [
    { text: "a", bold: true },
    { text: " and **b", bold: false },
  ]);
  assert.deepEqual(boldRuns(""), []);
});

// ---- the card ----

const good = {
  version: 2, prototype: true, eventName: "games night", status: "open", lead: "l", hostLine: "h", welcome: "",
  sections: [{ heading: "who sees what", paragraphs: ["p"] }, { bullets: ["b"] }],
  invite: "i", notForMe: ["that's fine."], conductUrl: null, hostName: "Sam", shareCodes: true,
};

test("asCard accepts a well-formed card and rejects anything else", () => {
  assert.equal(asCard(good)?.eventName, "games night");
  assert.equal(asCard(null), null);
  assert.equal(asCard({ ...good, status: "gone" }), null);
  assert.equal(asCard({ ...good, version: "2" }), null);
  assert.equal(asCard({ ...good, sections: [{ bullets: [1] }] }), null);
  assert.equal(asCard({ ...good, notForMe: "x" }), null);
  assert.equal(asCard({ ...good, hostName: 3 }), null);
});

test("safeHttpsUrl only lets https through", () => {
  assert.equal(safeHttpsUrl("https://example.org/conduct"), "https://example.org/conduct");
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpsUrl("http://example.org"), null);
  assert.equal(safeHttpsUrl(null), null);
  assert.equal(safeHttpsUrl("not a url"), null);
});

test("statusNote: a note for every status but open", () => {
  assert.equal(statusNote("open"), null);
  for (const s of ["paused", "full", "not_open_yet", "closed"] as const) assert.ok(statusNote(s));
});

// ---- the acknowledgement ----

test("ack round-trips under one sessionStorage key", () => {
  const s = memoryStorage();
  saveAck({ ackToken: "tok", version: 3 }, s);
  assert.deepEqual([...s.map.keys()], [ACK_KEY]);
  assert.deepEqual(loadAck(s), { ackToken: "tok", version: 3 });
  saveAck({ ackToken: "tok2", version: 4, prepareOnly: true }, s);
  assert.deepEqual(loadAck(s), { ackToken: "tok2", version: 4, prepareOnly: true });
  clearAck(s);
  assert.equal(loadAck(s), null);
});

test("ack storage never throws and ignores junk", () => {
  assert.doesNotThrow(() => saveAck({ ackToken: "t", version: 1 }, throwing()));
  assert.equal(loadAck(throwing()), null);
  assert.doesNotThrow(() => clearAck(throwing()));
  assert.equal(loadAck(null), null);
  const s = memoryStorage();
  s.setItem(ACK_KEY, "{not json");
  assert.equal(loadAck(s), null);
  s.setItem(ACK_KEY, JSON.stringify({ ackToken: "", version: 1 }));
  assert.equal(loadAck(s), null);
  assert.equal(currentStrangerPass(throwing()), null);
});

test("ackBody carries the pass only when there is one", () => {
  assert.deepEqual(ackBody("CODE", 2, null), { meetup: "CODE", cardVersion: 2 });
  assert.deepEqual(ackBody("CODE", 2, "p"), { meetup: "CODE", cardVersion: 2, pass: "p" });
});

// ---- leaving the meetup ----

test("urlWithoutMeetup drops only the meetup param", () => {
  assert.equal(urlWithoutMeetup("https://x.test/raising-intelligences/?meetup=ABC-123"), "/raising-intelligences/");
  assert.equal(urlWithoutMeetup("https://x.test/ri/?a=1&meetup=ABC&b=2#frag"), "/ri/?a=1&b=2#frag");
  assert.equal(urlWithoutMeetup("https://x.test/ri/?a=1"), null);
  assert.equal(urlWithoutMeetup("not a url"), null);
});

test("lowerLevel follows the level ceilings", () => {
  assert.equal(lowerLevel("outside", 3), 1);
  assert.equal(lowerLevel("outside", 1), 0);
  assert.equal(lowerLevel("outside", 0), null);
  assert.equal(lowerLevel("studio", 3), 0);
  assert.equal(lowerLevel("studio", 0), null);
});
