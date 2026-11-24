import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_PASS_KEY,
  CARRIES_NOTHING,
  EPILOGUE_HEADING,
  PANEL_NOTHING,
  PANEL_PENDING,
  accountRouteOn,
  asAccountPage,
  asCodeView,
  asShareMessage,
  asShareRow,
  formatDates,
  handlesAfterShare,
  hostForEvent,
  isAccountRoute,
  loadAccountPass,
  markdownBlocks,
  openUntil,
  panelLine,
  reportHostName,
  saveAccountPass,
  shareRowLines,
  shareViewLine,
  snapshotBlocks,
  stopWarning,
  watermarkLine,
  type AccountMeetup,
} from "../src/shareCodes.ts";
import { TOO_SMALL } from "../src/hostPortal.ts";

const NOV20 = Date.UTC(2026, 10, 20, 18, 0);
const NOV21 = Date.UTC(2026, 10, 21, 18, 0);
const DEC4 = Date.UTC(2026, 11, 4, 18, 0);

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

// ---- Snapshot ----

test("markdownBlocks: headings and paragraphs only", () => {
  const md = "# Ada\n\n## How it went\nShe grew up **kind**.\n- a list item\n> a quote line\n\n![img](https://x/y.png) [link](https://x)\n#### deep";
  assert.deepEqual(markdownBlocks(md), [
    { kind: "h1", text: "Ada" },
    { kind: "h2", text: "How it went" },
    { kind: "p", text: "She grew up kind." },
    { kind: "p", text: "a list item" },
    { kind: "p", text: "a quote line" },
    // Links and images stay literal text; nothing turns into markup.
    { kind: "p", text: "![img](https://x/y.png) [link](https://x)" },
    { kind: "h3", text: "deep" },
  ]);
});

test("markdownBlocks: HTML stays literal text", () => {
  assert.deepEqual(markdownBlocks("<img src=x onerror=alert(1)>"), [{ kind: "p", text: "<img src=x onerror=alert(1)>" }]);
});

test("snapshotBlocks: report card, then the epilogue under its heading", () => {
  const blocks = snapshotBlocks({ reportCard: "# Ada\nfine.", epilogue: "years later.\n\nthe end.", reportCardOmitted: false });
  assert.deepEqual(blocks, [
    { kind: "h1", text: "Ada" },
    { kind: "p", text: "fine." },
    { kind: "h2", text: EPILOGUE_HEADING },
    { kind: "p", text: "years later." },
    { kind: "p", text: "the end." },
  ]);
});

test("snapshotBlocks: an omitted report card carries only the epilogue; nothing at all is empty", () => {
  assert.deepEqual(snapshotBlocks({ reportCard: null, epilogue: "x.", reportCardOmitted: true }), [
    { kind: "h2", text: EPILOGUE_HEADING }, { kind: "p", text: "x." },
  ]);
  assert.deepEqual(snapshotBlocks({ reportCard: null, epilogue: null, reportCardOmitted: true }), []);
  assert.equal(CARRIES_NOTHING, "a code for this game would carry nothing.");
});

// ---- Share step ----

test("asShareMessage: views, previews and errors; nothing else", () => {
  assert.deepEqual(asShareMessage({ view: { state: "ask" } }), { view: { state: "ask" } });
  assert.deepEqual(asShareMessage({ view: { state: "later", until: DEC4 } }), { view: { state: "later", until: DEC4 } });
  assert.equal(asShareMessage({ view: { state: "later" } }), null);
  assert.equal(asShareMessage({ view: { state: "code", words: "a b c d" } }), null);
  assert.deepEqual(asShareMessage({ preview: null }), { preview: null });
  assert.deepEqual(asShareMessage({ preview: { reportCard: null, epilogue: "e", reportCardOmitted: true } }), {
    preview: { reportCard: null, epilogue: "e", reportCardOmitted: true },
  });
  assert.equal(asShareMessage({ preview: { reportCard: 3, epilogue: null } }), null);
  assert.deepEqual(asShareMessage({ error: "nope" }), { error: "nope" });
  assert.equal(asShareMessage("x"), null);
});

test("shareViewLine: the §5.1 lines, exactly", () => {
  assert.equal(shareViewLine({ state: "ask" }), null);
  assert.equal(shareViewLine({ state: "waiting" }), "if your co-parent says yes too, a code will appear on your account page.");
  assert.equal(shareViewLine({ state: "no" }), "okay, nothing will be made.");
  assert.equal(shareViewLine({ state: "later", until: DEC4 }, "UTC"), "you can decide on your account page until december 4, 2026.");
});

test("handlesAfterShare: the handle exchange waits for an answer, never for a refusal", () => {
  assert.equal(handlesAfterShare(false, null), true);
  assert.equal(handlesAfterShare(true, null), false);
  assert.equal(handlesAfterShare(true, { view: { state: "ask" } }), false);
  assert.equal(handlesAfterShare(true, { preview: null }), false);
  for (const v of [{ state: "waiting" }, { state: "no" }, { state: "later", until: DEC4 }] as const) {
    assert.equal(handlesAfterShare(true, { view: v }), true);
  }
  assert.equal(handlesAfterShare(true, { error: "Not available in this game." }), true);
});

// ---- Account page ----

test("asShareRow: each state, null, and junk", () => {
  assert.equal(asShareRow(null), null);
  assert.deepEqual(asShareRow({ state: "waiting" }), { state: "waiting" });
  assert.deepEqual(asShareRow({ state: "none" }), { state: "none" });
  assert.deepEqual(asShareRow({ state: "later", until: DEC4 }), { state: "later", until: DEC4 });
  assert.deepEqual(asShareRow({ state: "stopped", at: NOV21 }), { state: "stopped", at: NOV21 });
  assert.deepEqual(asShareRow({ state: "code", words: "a b c d", host: "Sam", until: DEC4, opened: [NOV21] }), {
    state: "code", words: "a b c d", host: "Sam", until: DEC4, opened: [NOV21],
  });
  assert.equal(asShareRow({ state: "code", words: "a b c d", host: "Sam", until: DEC4, opened: ["x"] }), undefined);
  assert.equal(asShareRow({ state: "later" }), undefined);
  assert.equal(asShareRow({ state: "ask" }), undefined);
  assert.equal(asShareRow(undefined), undefined);
});

test("asAccountPage: keeps good rows, drops malformed ones", () => {
  const card = {
    version: 1, prototype: true, eventName: "tea", status: "closed", lead: "l", hostLine: "h", welcome: "w",
    sections: [], invite: "i", notForMe: [], conductUrl: null, hostName: "Sam", shareCodes: true,
  };
  const page = asAccountPage({
    meetups: [{ ref: "e1", name: "tea", at: NOV20, card }, { ref: "", name: "x", at: 1, card: null }, { ref: "e2", name: "y", at: NOV20, card: { bad: 1 } }],
    games: [
      { ref: "g1", childName: "Ada", eventName: "tea", share: { state: "waiting" } },
      { ref: "g2", childName: "Bo", eventName: "tea", share: null },
      { ref: "g3", childName: "Cy", eventName: "tea", share: { state: "weird" } },
    ],
    hostSaw: [
      { name: "tea", panel: { kind: "pending" } },
      { name: "y", panel: { kind: "funnel", funnel: { tooSmall: true } } },
      { name: "z", panel: { kind: "funnel", funnel: { tooSmall: false } } },
    ],
  });
  assert.ok(page);
  assert.deepEqual(page.meetups.map((m) => [m.ref, m.card?.hostName ?? null]), [["e1", "Sam"], ["e2", null]]);
  assert.deepEqual(page.games.map((g) => g.ref), ["g1", "g2"]);
  assert.deepEqual(page.hostSaw.map((h) => h.name), ["tea", "y"]);
  assert.equal(asAccountPage({ meetups: [] }), null);
});

test("formatDates: one per day, joined with commas and 'and'", () => {
  assert.equal(formatDates([], "UTC"), "");
  assert.equal(formatDates([NOV21, NOV21 + 60_000], "UTC"), "november 21, 2026");
  assert.equal(formatDates([NOV21, NOV20], "UTC"), "november 20, 2026 and november 21, 2026");
  assert.equal(formatDates([NOV20, NOV21, DEC4], "UTC"), "november 20, 2026, november 21, 2026 and december 4, 2026");
});

const text = (runs: { text: string }[]) => runs.map((r) => r.text).join("");

test("shareRowLines: the §B.5 account lines, exactly", () => {
  assert.equal(text(shareRowLines({ state: "waiting" }).runs), "you said yes. if your co-parent says yes too, a code will appear here.");
  const later = shareRowLines({ state: "later", until: DEC4 }, "UTC");
  assert.equal(text(later.runs), "you haven't decided yet. you can until december 4, 2026.");
  assert.equal(later.action, "decide");
  assert.equal(text(shareRowLines({ state: "none" }).runs), "no code was made for this game.");
  assert.equal(text(shareRowLines({ state: "stopped", at: NOV21 }, "UTC").runs), "you stopped this code on november 21, 2026.");
});

test("shareRowLines: a code's words are the one bold run, with its access log", () => {
  const unopened = shareRowLines({ state: "code", words: "apple brick cloud dune", host: "Sam", until: DEC4, opened: [] }, "UTC");
  assert.equal(
    text(unopened.runs),
    "share code for Sam: apple brick cloud dune. give it to Sam when and if you want to. it works for Sam only, until december 4, 2026.",
  );
  assert.deepEqual(unopened.runs.filter((r) => r.bold).map((r) => r.text), ["apple brick cloud dune"]);
  assert.equal(unopened.access, "Sam hasn't opened it.");
  assert.equal(unopened.action, "stop");
  // A host name with markup in it stays plain text.
  const opened = shareRowLines({ state: "code", words: "a b c d", host: "**Sam**", until: DEC4, opened: [NOV20, NOV21] }, "UTC");
  assert.deepEqual(opened.runs.filter((r) => r.bold).map((r) => r.text), ["a b c d"]);
  assert.equal(opened.access, "**Sam** opened it on november 20, 2026 and november 21, 2026.");
});

test("stopWarning: the §B.5 warning", () => {
  assert.equal(
    stopWarning("Sam"),
    "stopping it means Sam can't open it again. it can't make Sam forget what they've already read. Sam will see that it no longer opens, and might say so in front of your co-parent.",
  );
});

test("panelLine: published bands, too small, pending, nothing", () => {
  assert.equal(panelLine({ kind: "pending" }), PANEL_PENDING);
  assert.equal(PANEL_PENDING, "nothing yet. numbers, if there are any, appear a day after the meetup closes.");
  assert.equal(panelLine({ kind: "nothing" }), PANEL_NOTHING);
  assert.equal(panelLine({ kind: "funnel", funnel: { tooSmall: true } }), TOO_SMALL);
  assert.equal(
    panelLine({ kind: "funnel", funnel: { tooSmall: false, joined: "10–19", started: "5–9", finished: "more than half", swapped: null } }),
    "joined the queue: 10–19 · games started: 5–9 · games finished: more than half",
  );
});

const meetup = (name: string, hostName: string | null): AccountMeetup => ({
  ref: name, name, at: NOV20,
  card: {
    version: 1, prototype: true, eventName: name, status: "closed", lead: "", hostLine: "", welcome: "", sections: [],
    invite: "", notForMe: [], conductUrl: null, hostName, shareCodes: true,
  },
});

test("hostForEvent and reportHostName: from the agreed cards, with plain fallbacks", () => {
  const ms = [meetup("tea", "Sam"), meetup("pie", null)];
  assert.equal(hostForEvent(ms, "tea"), "Sam");
  assert.equal(hostForEvent(ms, "pie"), "your host");
  assert.equal(hostForEvent(ms, "gone"), "your host");
  assert.equal(reportHostName([meetup("tea", "Sam"), meetup("pie", "Sam")]), "Sam");
  assert.equal(reportHostName([meetup("tea", "Sam"), meetup("pie", "Kit")]), "the host");
  assert.equal(reportHostName([]), "the host");
});

// ---- Code view ----

test("asCodeView and the watermark", () => {
  const v = asCodeView({
    snapshot: { reportCard: "# A", epilogue: null, reportCardOmitted: false },
    until: DEC4,
    watermark: { reader: "Sam", openedAt: NOV21 },
  });
  assert.ok(v);
  assert.equal(watermarkLine(v.watermark, "UTC"), "opened by Sam on november 21, 2026 · for a conversation with this pair only · don't copy or share");
  assert.equal(openUntil(v.until, "UTC"), "you can open this until december 4, 2026.");
  assert.equal(asCodeView({ snapshot: null, until: DEC4, watermark: { reader: "Sam", openedAt: NOV21 } }), null);
  assert.equal(asCodeView({ snapshot: { reportCard: null, epilogue: null }, until: DEC4 }), null);
});

// ---- Pass and route ----

test("account pass: kept for the tab, cleared, and silent when storage throws", () => {
  const s = memoryStorage();
  assert.equal(loadAccountPass(s), null);
  saveAccountPass("p1", s);
  assert.equal(s.map.get(ACCOUNT_PASS_KEY), "p1");
  assert.equal(loadAccountPass(s), "p1");
  saveAccountPass(null, s);
  assert.equal(loadAccountPass(s), null);
  assert.doesNotThrow(() => saveAccountPass("p", throwing()));
  assert.equal(loadAccountPass(throwing()), null);
  assert.equal(loadAccountPass(null), null);
});

test("isAccountRoute and accountRouteOn", () => {
  assert.equal(isAccountRoute("?stranger=account"), true);
  assert.equal(isAccountRoute("?stranger=identity"), false);
  assert.equal(isAccountRoute(""), false);
  assert.equal(accountRouteOn(401, true), true);
  assert.equal(accountRouteOn(200, true), true);
  assert.equal(accountRouteOn(404, false), false);
  assert.equal(accountRouteOn(200, false), false);
  assert.equal(accountRouteOn(500, true), false);
});
