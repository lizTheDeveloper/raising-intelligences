import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { REQUEST_TIMEOUT_MS } from "../src/llm/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", "src", p), "utf8");

/**
 * The streaming and non-streaming request budgets used to differ — 120s vs 90s
 * — and the shorter one was on the path that needs the *longer* one, because a
 * non-streaming call shows the player nothing until it completes. A production
 * `world_manager` call was measured at 74.9s, 83% of the old 90s ceiling, and
 * timeouts are deliberately not retried, so a slow response was a dead scene.
 *
 * These are source-text assertions on purpose. A behavioural test would have to
 * hold a real request open for two minutes; the actual failure mode here is not
 * a wrong value at runtime but the two budgets silently drifting apart again
 * when someone tunes one call site. That is exactly what reading the source
 * catches and what mocking the client would not.
 */
describe("LLM request timeout parity", () => {
  const routing = src("llm/routing-client.ts");
  const openrouter = src("llm/openrouter.ts");

  it("gives every generation call site the same budget, from one constant", () => {
    // 60s on the OpenRouter cheap-model health/probe path is deliberate and separate.
    const literals = [...routing.matchAll(/AbortSignal\.timeout\((\d[\d_]*)\)/g)].map((m) => m[1]);
    expect(literals).toEqual([]);

    const orLiterals = [...openrouter.matchAll(/AbortSignal\.timeout\((\d[\d_]*)\)/g)].map((m) => m[1]);
    expect(orLiterals).toEqual(["60_000"]);
  });

  it("routes both clients through REQUEST_TIMEOUT_MS", () => {
    expect(routing).toContain("REQUEST_TIMEOUT_MS");
    expect(openrouter).toContain("REQUEST_TIMEOUT_MS");
    // The streaming override must default to the shared budget, not a literal.
    expect(routing).toMatch(/STREAM_TIMEOUT_MS\s*=\s*Number\(process\.env\.STREAM_TIMEOUT_MS\s*\?\?\s*REQUEST_TIMEOUT_MS\)/);
  });

  it("leaves enough headroom over observed generation latency", () => {
    // Measured in production 2026-08-02: a world_manager call took 74.9s.
    // If this ever needs lowering below that, the retry policy has to change too.
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});
