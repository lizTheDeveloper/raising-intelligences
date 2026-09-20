import OpenAI from "openai";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChildSeedClient } from "../src/llm/child-seed-client.js";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMRole } from "../src/llm/model-config.js";
import { _resetPoolCacheForTests, _setPoolForTests } from "../src/llm/model-config.js";
import type { PoolEntry } from "../src/llm/model-config.js";

function makeMockClient(): LLMClient & { lastRole?: LLMRole } {
  const mock: LLMClient & { lastRole?: LLMRole } = {
    async streamResponse(_sys, _msgs, onChunk, role) {
      mock.lastRole = role;
      onChunk("hello");
      return "hello";
    },
    async completeResponse(_sys, _msg, _max, role) {
      mock.lastRole = role;
      return "response";
    },
    async completeJson<T>(_sys: string, _msg: string, role?: LLMRole) {
      mock.lastRole = role;
      return {} as T;
    },
  };
  return mock;
}

function rateLimitError(): OpenAI.RateLimitError {
  return new OpenAI.RateLimitError(429, { message: "rate limited" }, "rate limited", new Headers());
}

function notFoundError(): OpenAI.NotFoundError {
  return new OpenAI.NotFoundError(404, { message: "model removed" }, "model removed", new Headers());
}

/**
 * A mock routing client whose withModelOverride() returns a per-model client
 * so tests can make one slug fail and another succeed, mirroring how
 * RoutingLLMClient actually resolves the model to call.
 */
function makeMockRoutingClientWithModelFailures(
  failingModels: Set<string>,
  failureFactory: () => Error
): LLMClient & { withModelOverride: (model: string) => LLMClient; callsByModel: Record<string, number> } {
  const callsByModel: Record<string, number> = {};
  const forModel = (model: string): LLMClient => ({
    async streamResponse(_sys, _msgs, onChunk) {
      callsByModel[model] = (callsByModel[model] ?? 0) + 1;
      if (failingModels.has(model)) throw failureFactory();
      onChunk("hello");
      return "hello";
    },
    async completeResponse(_sys, _msg, _max, _role, onChunk) {
      callsByModel[model] = (callsByModel[model] ?? 0) + 1;
      if (failingModels.has(model)) throw failureFactory();
      onChunk?.("response");
      return "response";
    },
    async completeJson<T>() {
      callsByModel[model] = (callsByModel[model] ?? 0) + 1;
      if (failingModels.has(model)) throw failureFactory();
      return {} as T;
    },
  });
  const base = forModel("__unused__");
  return {
    ...base,
    callsByModel,
    withModelOverride: (model: string) => forModel(model),
  };
}

const pool: PoolEntry[] = [
  { slug: "test-model-a", freeSlug: null, weight: 1 },
  { slug: "test-model-b", freeSlug: null, weight: 1 },
];

describe("ChildSeedClient", () => {
  beforeEach(() => {
    _resetPoolCacheForTests();
    _setPoolForTests("standard", pool);
  });

  it("delegates non-kid roles directly to inner client", async () => {
    const inner = makeMockClient();
    const client = new ChildSeedClient(inner, "standard", "game-123");
    await client.completeResponse("sys", "msg", 500, "psychologist");
    expect(inner.lastRole).toBe("psychologist");
  });

  it("delegates non-kid roles without modifying them", async () => {
    const inner = makeMockClient();
    const client = new ChildSeedClient(inner, "standard", "game-123");
    await client.completeResponse("sys", "msg", 500, "world_manager");
    expect(inner.lastRole).toBe("world_manager");
  });

  it("resolves a kid model for kid_family_chat role", async () => {
    const inner = makeMockClient();
    const client = new ChildSeedClient(inner, "standard", "game-123");
    await client.streamResponse("sys", [], () => {}, "kid_family_chat");
    // The inner client should have been called — the model override happens
    // at a level above the LLMClient interface (in the routing client).
    // ChildSeedClient's job is to expose the resolved kidModel.
    expect(client.kidModel).toBeTruthy();
    expect(["test-model-a", "test-model-b"]).toContain(client.kidModel);
  });

  it("resolves the same model for all kid roles on the same gameId", async () => {
    const inner = makeMockClient();
    const client = new ChildSeedClient(inner, "standard", "game-sticky");
    await client.streamResponse("sys", [], () => {}, "kid_family_chat");
    const model1 = client.kidModel;
    await client.completeResponse("sys", "msg", 500, "kid_sidebar");
    const model2 = client.kidModel;
    await client.completeResponse("sys", "msg", 500, "kid_adult_chat");
    const model3 = client.kidModel;
    expect(model1).toBe(model2);
    expect(model2).toBe(model3);
  });

  describe("free-tier fallback on 429/404", () => {
    const poolWithFree: PoolEntry[] = [
      { slug: "paid/model", freeSlug: "paid/model:free", weight: 1 },
    ];

    beforeEach(() => {
      _resetPoolCacheForTests();
      _setPoolForTests("standard", poolWithFree);
    });

    it("retries completeJson against the paid slug on a 429", async () => {
      const inner = makeMockRoutingClientWithModelFailures(
        new Set(["paid/model:free"]),
        rateLimitError
      );
      const client = new ChildSeedClient(inner, "standard", "game-429");
      const result = await client.completeJson("sys", "msg", "kid_family_chat");
      expect(result).toEqual({});
      expect(inner.callsByModel["paid/model:free"]).toBe(1);
      expect(inner.callsByModel["paid/model"]).toBe(1);
      expect(client.kidModel).toBe("paid/model");
    });

    it("retries completeJson against the paid slug on a 404", async () => {
      const inner = makeMockRoutingClientWithModelFailures(
        new Set(["paid/model:free"]),
        notFoundError
      );
      const client = new ChildSeedClient(inner, "standard", "game-404");
      await client.completeJson("sys", "msg", "kid_family_chat");
      expect(inner.callsByModel["paid/model:free"]).toBe(1);
      expect(inner.callsByModel["paid/model"]).toBe(1);
      expect(client.kidModel).toBe("paid/model");
    });

    it("retries completeResponse (non-streaming) against the paid slug on a 429", async () => {
      const inner = makeMockRoutingClientWithModelFailures(
        new Set(["paid/model:free"]),
        rateLimitError
      );
      const client = new ChildSeedClient(inner, "standard", "game-429-complete");
      const result = await client.completeResponse("sys", "msg", 500, "kid_family_chat");
      expect(result).toBe("response");
      expect(inner.callsByModel["paid/model"]).toBe(1);
    });

    it("does not retry once a stream has already emitted content", async () => {
      // Simulate a stream that emits a chunk and THEN throws — retrying would
      // duplicate visible output, so the error must surface instead.
      const flaky: LLMClient & { withModelOverride: (m: string) => LLMClient } = {
        async streamResponse(_sys, _msgs, onChunk) {
          onChunk("partial");
          throw rateLimitError();
        },
        async completeResponse() {
          return "unused";
        },
        async completeJson<T>() {
          return {} as T;
        },
        withModelOverride(_model: string) {
          return flaky;
        },
      };
      const client = new ChildSeedClient(flaky, "standard", "game-no-retry");
      await expect(
        client.streamResponse("sys", [], () => {}, "kid_family_chat")
      ).rejects.toThrow();
    });

    it("does not retry on errors that are not 429/404", async () => {
      const inner = makeMockRoutingClientWithModelFailures(
        new Set(["paid/model:free"]),
        () => new Error("boom")
      );
      const client = new ChildSeedClient(inner, "standard", "game-other-error");
      await expect(
        client.completeJson("sys", "msg", "kid_family_chat")
      ).rejects.toThrow("boom");
      expect(inner.callsByModel["paid/model"]).toBeUndefined();
    });
  });
});
