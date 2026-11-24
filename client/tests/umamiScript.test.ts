// Privacy review F5: Umami must never record the query string. Page URLs here
// carry ?game=<id> (a read credential, before 2.8.5) and ?meetup=<code> (the
// event a player opened). Custom events carry their own properties; none of
// them reads the query string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { umamiScriptAttributes, analyticsAllowed, umamiBeforeSend, BEFORE_SEND_HOOK, meetupSession } from "../src/umamiScript.js";

test("the Umami script is told to drop the query string", () => {
  const a = umamiScriptAttributes("multiversegames.ai");
  assert.equal(a["data-exclude-search"], "true");
  assert.equal(a["data-website-id"], "70687d81-c604-4643-a6b6-9d0bccdba970");
  assert.equal(a.src, "https://analytics.multiversegames.ai/script.js");
});

test("the .xyz host still loads analytics from .xyz", () => {
  assert.equal(umamiScriptAttributes("multiversestudios.xyz").src, "https://analytics.multiversestudios.xyz/script.js");
  assert.equal(umamiScriptAttributes("multiversestudios.xyz")["data-exclude-search"], "true");
});

// Persona tests (Priya, finding 8): GPC means no Umami at all, and a meetup
// session never tells Umami where the player came from.
test("Global Privacy Control: no analytics at all", () => {
  assert.equal(analyticsAllowed({ globalPrivacyControl: true }), false);
  assert.equal(analyticsAllowed({ globalPrivacyControl: false }), true);
  assert.equal(analyticsAllowed({}), true);
  assert.equal(analyticsAllowed(undefined), true);
});

test("every payload goes through the before-send hook", () => {
  assert.equal(umamiScriptAttributes("multiversegames.ai")["data-before-send"], BEFORE_SEND_HOOK);
});

test("before-send: a meetup session sends no referrer; no referrer or url ever carries a query or fragment", () => {
  const base = { website: "w", url: "https://multiversegames.ai/raising-intelligences/", title: "t" };
  const promoter = { ...base, referrer: "https://sparknight.example/events/friday?utm_source=dev" };
  assert.equal(umamiBeforeSend("event", promoter, { meetupSession: true }).referrer, "");
  // Outside a meetup session the referrer domain and path stay, the query goes.
  assert.equal(umamiBeforeSend("event", promoter, { meetupSession: false }).referrer, "https://sparknight.example/events/friday");
  // The page a player reloads from after a meetup card is our own, with the code in it.
  const own = { ...base, referrer: "https://multiversegames.ai/raising-intelligences/?meetup=linen-spin-budget-sustain" };
  assert.equal(umamiBeforeSend("event", own, { meetupSession: false }).referrer, "https://multiversegames.ai/raising-intelligences/");
  const url = { ...base, url: "https://multiversegames.ai/raising-intelligences/?meetup=x#handoff=y", referrer: "" };
  assert.equal(umamiBeforeSend("pageview", url, { meetupSession: false }).url, "https://multiversegames.ai/raising-intelligences/");
  // The rest of the payload is untouched.
  assert.equal(umamiBeforeSend("event", promoter, { meetupSession: true }).title, "t");
});

test("a meetup session lasts for the tab, past the reload to the title screen", () => {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(meetupSession(false, storage), false);
  assert.equal(meetupSession(true, storage), true);
  assert.equal(meetupSession(false, storage), true);
  const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
  assert.equal(meetupSession(true, broken), true);
  assert.equal(meetupSession(false, broken), false);
  assert.equal(meetupSession(false, undefined), false);
});
