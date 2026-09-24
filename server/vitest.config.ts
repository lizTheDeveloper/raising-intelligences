import { defineConfig } from "vitest/config";

// When recording cassettes we make live LLM calls behind socket round-trips —
// some qwen generations run well over a minute, and a truncation-escalating
// world-manager call can take several — so the per-test ceiling has to be
// generous. In replay everything resolves in milliseconds, so a tight ceiling
// keeps real hangs fast to surface.
const RECORDING =
  process.env.LLM_CACHE_MODE === "record" || process.env.LLM_CACHE_MODE === "auto";

export default defineConfig({
  test: {
    testTimeout: RECORDING ? 900_000 : 30_000,
    hookTimeout: RECORDING ? 900_000 : 30_000,
    // Each E2E file owns its own cassette + server; isolate files in forks.
    // Sequential within a file is the vitest default.
    pool: "forks",
  },
});
