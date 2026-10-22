import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBirthYear } from "../src/birthYear.js";

const NOW = new Date("2026-06-01T00:00:00Z");

test("accepts 4-digit years from 1900 to the current year", () => {
  assert.equal(parseBirthYear("1990", NOW), 1990);
  assert.equal(parseBirthYear("1900", NOW), 1900);
  assert.equal(parseBirthYear("2026", NOW), 2026);
});

test("rejects out-of-range years", () => {
  assert.equal(parseBirthYear("1899", NOW), null);
  assert.equal(parseBirthYear("2027", NOW), null);
});

test("rejects anything that is not exactly 4 digits", () => {
  for (const bad of ["", "199", "19900", "abcd", "19 0", "-199", "1990.", " 1990"]) {
    assert.equal(parseBirthYear(bad, NOW), null, bad);
  }
});
