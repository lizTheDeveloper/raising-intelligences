/**
 * Regression tests for the GitHub #149 `error: null` fix (client/src/errorReporting.ts).
 * The client has no test harness of its own, so this runs under tsx like the other
 * scripts in this directory:  npx tsx scripts/test-error-reporting.ts
 */
import assert from "node:assert/strict";
import { normalizeNullPayload, toReportableRejection, toReportableWindowError } from "../client/src/errorReporting.ts";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

check("real Errors pass through untouched", () => {
  const boom = new Error("boom");
  assert.equal(toReportableWindowError({ error: boom }), boom);
  assert.equal(toReportableRejection(boom), boom);
});

check("null error with a message reports a real Error naming it", () => {
  const err = toReportableWindowError({
    error: null,
    message: "something went sideways",
    filename: "https://example.com/app.js",
    lineno: 12,
    colno: 3,
  });
  assert.ok(err instanceof Error);
  assert.match(err.message, /window error: something went sideways/);
  assert.match(err.message, /app\.js:12:3/);
});

check("null error with no context still produces a message, never null", () => {
  const err = toReportableWindowError({ error: null, message: "", filename: "" });
  assert.ok(err instanceof Error);
  assert.ok(err.message.length > 0);
  assert.notEqual(err.message, "null");
});

check("blocked-resource load events are dropped", () => {
  assert.equal(toReportableWindowError({ error: null, message: "", isResourceLoad: true }), null);
});

check("opaque cross-origin Script error. is dropped", () => {
  assert.equal(toReportableWindowError({ error: null, message: "Script error.", filename: "" }), null);
});

check("Promise.reject(null) reports a real Error, not null", () => {
  const err = toReportableRejection(null);
  assert.ok(err instanceof Error);
  assert.match(err.message, /rejected with null/);
});

check("bare reject() reports a real Error", () => {
  assert.match(toReportableRejection(undefined).message, /rejected with undefined/);
});

check("string reasons are kept but truncated", () => {
  const long = "x".repeat(500);
  const err = toReportableRejection(long);
  assert.ok(err.message.startsWith("unhandledrejection: "));
  assert.ok(err.message.length < 300);
});

check("non-Error object reasons serialize keys only, never values", () => {
  const err = toReportableRejection({ status: 500, body: "secret transcript text" });
  assert.ok(!err.message.includes("secret"));
  assert.match(err.message, /Object \{status,body\}/);
});

check("normalizeNullPayload rewrites a verbatim null-payload event", () => {
  const event = {
    exception: {
      values: [
        {
          type: "Error",
          value: "null",
          mechanism: { type: "auto.browser.browserapierrors.setTimeout", handled: false },
          stacktrace: { frames: [{ filename: "https://example.com/app.js", lineno: 7, colno: 1 }] },
        },
      ],
    },
  };
  normalizeNullPayload(event);
  const v = event.exception.values[0];
  assert.equal(v.type, "NullErrorPayload");
  assert.match(v.value ?? "", /^null error payload from auto\.browser\.browserapierrors\.setTimeout/);
  assert.match(v.value ?? "", /app\.js:7:1/);
});

check("normalizeNullPayload leaves real events untouched", () => {
  const event = { exception: { values: [{ type: "TypeError", value: "x is not a function" }] } };
  normalizeNullPayload(event);
  assert.equal(event.exception.values[0].value, "x is not a function");
  assert.equal(event.exception.values[0].type, "TypeError");
});

console.log(`\n${passed} checks passed`);
