// Privacy review F5: Umami must never record the query string. Page URLs here
// carry ?game=<id> (a read credential, before 2.8.5) and ?meetup=<code> (the
// event a player opened). Custom events carry their own properties; none of
// them reads the query string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { umamiScriptAttributes } from "../src/umamiScript.js";

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
