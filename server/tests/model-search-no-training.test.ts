import { describe, it, expect } from "vitest";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NO_TRAINING_ROUTE, benchmarkRequest } from "../src/observability/hosted-analysis.js";

/**
 * The studio-learning card says an allow-listed game is "never published or
 * used to train AI". model-search replays real prompts (allow-listed meetup
 * games among them) against candidate models through OpenRouter, including
 * free endpoints whose providers may keep or train on prompts. Every request
 * it makes must ask OpenRouter for providers that don't (data_collection:
 * deny); a model with no such provider fails rather than leaks.
 */
describe("model-search never sends prompts where they may be trained on", () => {
  it("the request asks OpenRouter for no data collection", () => {
    expect(NO_TRAINING_ROUTE).toEqual({ data_collection: "deny" });
    const body = benchmarkRequest("some/model:free", [{ role: "user", content: "hi" }]);
    expect(body).toEqual({ model: "some/model:free", messages: [{ role: "user", content: "hi" }], max_tokens: 500, provider: { data_collection: "deny" } });
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const modelSearch = path.join(__dirname, "..", "..", "scripts", "model-search.ts");
  // scripts/ is not copied into the Docker test stage; the check runs wherever the repo is whole.
  it.skipIf(!existsSync(modelSearch))("scripts/model-search.ts builds every request with benchmarkRequest", () => {
    const src = readFileSync(modelSearch, "utf8");
    expect(src).toContain("benchmarkRequest(");
    expect(src).not.toMatch(/chat\.completions\.create\(\s*\{\s*model/);
  });
});
