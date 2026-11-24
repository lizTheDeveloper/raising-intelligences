import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MINOR_OTHER_WAYS } from "../src/strangerCopy.ts";

const SRC = join(import.meta.dirname, "..", "src");

/** Every .ts/.tsx file the client ships. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test("the minor screen promises only solo play as free (an invite game can cost $20)", () => {
  assert.equal(MINOR_OTHER_WAYS, "you can still raise a child on your own for free, or with someone you invite.");
  assert.doesNotMatch(MINOR_OTHER_WAYS, /both are free/);
});

test("no shipped copy says invite play is free: 'both are free' appears nowhere in the client", () => {
  const hits = sources(SRC).filter((f) => readFileSync(f, "utf8").includes("both are free"));
  assert.deepEqual(hits, []);
  assert.match(readFileSync(join(SRC, "components", "StrangerMode.tsx"), "utf8"), /MINOR_OTHER_WAYS/);
});
