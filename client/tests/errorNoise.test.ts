// Unit tests for the MUL-13 third-party frame guard. Zero new dependencies:
// run with tsx (hoisted from the server workspace) — see client/package.json
// "test" script. Fixtures follow the MUL-13 contract: (a) own bundled frame
// kept, (b) only webkit-masked-url://hidden/ dropped, (c) mixed kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventHasOnlyThirdPartyFrames, frameIsOpaqueOrForeign } from "../src/errorNoise.js";

const PAGE = "https://play.multiversegames.ai";

const ev = (...framesPerEx: string[][]) => ({
  exception: {
    values: framesPerEx.map((frames) => ({
      type: "Error",
      value: "boom",
      stacktrace: { frames: frames.map((filename) => ({ filename })) },
    })),
  },
});

test("frameIsOpaqueOrForeign keeps same-origin, studio-host, relative, same-origin blob frames", () => {
  assert.equal(frameIsOpaqueOrForeign(`${PAGE}/assets/index-abc123.js`, PAGE), false);
  assert.equal(frameIsOpaqueOrForeign("https://cdn.multiversegames.ai/x.js", PAGE), false);
  assert.equal(frameIsOpaqueOrForeign("/src/main.tsx", PAGE), false);
  assert.equal(frameIsOpaqueOrForeign("blob:" + PAGE + "/uuid", PAGE), false);
});

test("frameIsOpaqueOrForeign drops opaque and foreign-origin frames", () => {
  assert.equal(frameIsOpaqueOrForeign("webkit-masked-url://hidden/", PAGE), true);
  assert.equal(frameIsOpaqueOrForeign("about:srcdoc", PAGE), true);
  assert.equal(frameIsOpaqueOrForeign("", PAGE), true);
  assert.equal(frameIsOpaqueOrForeign(undefined, PAGE), true);
  assert.equal(frameIsOpaqueOrForeign("user-script:42", PAGE), true);
  assert.equal(frameIsOpaqueOrForeign("chrome-extension://abc/content.js", PAGE), true);
  assert.equal(frameIsOpaqueOrForeign("moz-extension://abc/x.js", PAGE), true);
  assert.equal(frameIsOpaqueOrForeign("safari-web-extension://abc/x.js", PAGE), true);
  assert.equal(frameIsOpaqueOrForeign("https://evil.example/inject.js", PAGE), true);
  assert.equal(frameIsOpaqueOrForeign("blob:https://evil.example/uuid", PAGE), true);
});

test("(a) our own bundled frame -> kept", () => {
  assert.equal(eventHasOnlyThirdPartyFrames(ev([`${PAGE}/assets/index-abc123.js`]), PAGE), false);
});

test("(b) only webkit-masked-url://hidden/ -> dropped", () => {
  assert.equal(eventHasOnlyThirdPartyFrames(ev(["webkit-masked-url://hidden/"]), PAGE), true);
});

test("(c) mixed ours + third-party -> kept", () => {
  assert.equal(
    eventHasOnlyThirdPartyFrames(ev([`${PAGE}/assets/main.js`, "chrome-extension://abc/inject.js"]), PAGE),
    false,
  );
});

test("multi-exception stacks drop only when every frame is opaque/foreign", () => {
  assert.equal(eventHasOnlyThirdPartyFrames(ev(["about:blank"], ["https://evil.example/a.js"]), PAGE), true);
  assert.equal(eventHasOnlyThirdPartyFrames(ev(["about:blank"], [`${PAGE}/x.js`]), PAGE), false);
});

test("conservative: events without attribute-able frames are kept", () => {
  assert.equal(eventHasOnlyThirdPartyFrames({ message: "hi" } as never, PAGE), false);
  assert.equal(eventHasOnlyThirdPartyFrames({ exception: { values: [] } } as never, PAGE), false);
  assert.equal(eventHasOnlyThirdPartyFrames({ exception: { values: [{ type: "Error" }] } } as never, PAGE), false);
});

test("abs_path wins over filename", () => {
  const event = {
    exception: {
      values: [{ stacktrace: { frames: [{ filename: "eval at <anonymous>", abs_path: `${PAGE}/app.js` }] } }],
    },
  };
  assert.equal(eventHasOnlyThirdPartyFrames(event, PAGE), false);
});
