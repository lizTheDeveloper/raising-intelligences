# Kid Model Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the one-archetype convergence across RI childhoods by rotating the kid LLM across a DB-configurable pool of models, sticky per child.

**Architecture:** Two DB tables (`kid_model_benchmarks` for search results, `kid_model_pool` for production pool). A `selectKidModel(tier, gameId)` function hashes the gameId to pick from the weighted pool. A `ChildSeedClient` wrapper makes this transparent to the conversation engine. A `scripts/model-search.ts` CLI tool benchmarks candidates against real Langfuse prompts.

**Tech Stack:** TypeScript, Postgres (pg), OpenRouter API, Langfuse REST API, Vitest

**Spec:** `docs/superpowers/specs/2026-09-17-kid-model-rotation-design.md`

## Global Constraints

- All LLM calls go through OpenRouter (`https://openrouter.ai/api/v1`)
- Safety models (`safety_check`) always stay on `anthropic/claude-haiku-4-5` — never rotated
- Non-kid roles (psychologist, world_manager, epilogue, etc.) are never rotated
- Migrations use numbered `.sql` files in `server/src/db/migrations/`, applied by `migrate.ts`
- Tests use Vitest (`npx vitest run` from `server/`)
- The `LLMClient` interface (`server/src/llm/client.ts`) must not change
- Scripts go in `games/raising-intelligences/scripts/`
- English enforcement (`enforceEnglish`) in `routing-client.ts` must apply to rotated models too

---

### Task 1: DB Migration — Benchmark and Pool Tables

**Files:**
- Create: `server/src/db/migrations/020-kid-model-tables.sql`

**Interfaces:**
- Consumes: nothing
- Produces: Two Postgres tables (`kid_model_benchmarks`, `kid_model_pool`) available via `pool.query()`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 020-kid-model-tables.sql
--
-- Model search pipeline (kid_model_benchmarks) and production rotation pool
-- (kid_model_pool) for kid LLM diversity. See docs/superpowers/specs/
-- 2026-09-17-kid-model-rotation-design.md.

CREATE TABLE IF NOT EXISTS kid_model_benchmarks (
  id              serial PRIMARY KEY,
  model_slug      text NOT NULL,
  prompt_id       text NOT NULL,
  sensory_score   real,
  cast_score      real,
  coping_archetype text,
  english_quality  boolean NOT NULL DEFAULT true,
  response_tokens  int,
  cost_usd         real,
  raw_excerpt      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_benchmarks_model ON kid_model_benchmarks(model_slug);

CREATE TABLE IF NOT EXISTS kid_model_pool (
  id          serial PRIMARY KEY,
  slug        text NOT NULL,
  free_slug   text,
  tier        text NOT NULL DEFAULT 'standard',
  weight      int NOT NULL DEFAULT 1,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(slug, tier)
);
```

Save to `server/src/db/migrations/020-kid-model-tables.sql`.

- [ ] **Step 2: Verify migration applies**

Run: `cd server && DATABASE_URL=postgres://postgres:postgres@localhost:5432/raising_intelligences npx tsx src/db/migrate.ts`

Expected: `migration_applied { name: '020-kid-model-tables.sql' }`

- [ ] **Step 3: Commit**

```bash
git add server/src/db/migrations/020-kid-model-tables.sql
git commit -m "feat(db): add kid_model_benchmarks and kid_model_pool tables"
```

---

### Task 2: Pool Selection Logic

**Files:**
- Modify: `server/src/llm/model-config.ts`
- Create: `server/tests/kid-model-pool.test.ts`

**Interfaces:**
- Consumes: `kid_model_pool` table from Task 1; `pool.query()` from `server/src/db/pool.ts`
- Produces:
  - `PoolEntry` interface: `{ slug: string; freeSlug: string | null; weight: number }`
  - `hashGameId(gameId: string, totalWeight: number): number` — deterministic uint32 mod
  - `getKidModelPool(tier: ModelTier): Promise<{ models: PoolEntry[]; totalWeight: number }>` — cached DB query
  - `selectKidModel(tier: ModelTier, gameId: string): Promise<string>` — returns model slug for this child
  - `KID_ROLES` constant: `new Set(["kid_family_chat", "kid_sidebar", "kid_adult_chat"])`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/kid-model-pool.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { hashGameId, selectKidModel, _resetPoolCacheForTests, _setPoolForTests } from "../src/llm/model-config.js";
import type { PoolEntry } from "../src/llm/model-config.js";

describe("hashGameId", () => {
  it("returns a deterministic value for the same gameId", () => {
    const a = hashGameId("game-abc-123", 10);
    const b = hashGameId("game-abc-123", 10);
    expect(a).toBe(b);
  });

  it("returns different values for different gameIds", () => {
    const a = hashGameId("game-abc-123", 1000);
    const b = hashGameId("game-xyz-789", 1000);
    expect(a).not.toBe(b);
  });

  it("result is always in [0, totalWeight)", () => {
    for (let i = 0; i < 100; i++) {
      const val = hashGameId(`game-${i}`, 5);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(5);
    }
  });
});

describe("selectKidModel", () => {
  const pool: PoolEntry[] = [
    { slug: "model-a", freeSlug: null, weight: 1 },
    { slug: "model-b", freeSlug: "model-b:free", weight: 2 },
    { slug: "model-c", freeSlug: null, weight: 1 },
  ];

  beforeEach(() => {
    _resetPoolCacheForTests();
    _setPoolForTests("standard", pool);
  });

  it("returns a model from the pool", async () => {
    const result = await selectKidModel("standard", "game-test-1");
    const allSlugs = pool.flatMap((p) => [p.slug, p.freeSlug].filter(Boolean));
    expect(allSlugs).toContain(result);
  });

  it("is sticky — same gameId always gets same model", async () => {
    const a = await selectKidModel("standard", "game-sticky-test");
    const b = await selectKidModel("standard", "game-sticky-test");
    expect(a).toBe(b);
  });

  it("distributes across the pool (not all the same model)", async () => {
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      results.add(await selectKidModel("standard", `game-dist-${i}`));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it("prefers free_slug when present", async () => {
    // model-b has free_slug "model-b:free" and weight 2
    // With enough tries, some gameId should land on model-b
    const results: string[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(await selectKidModel("standard", `game-free-${i}`));
    }
    expect(results).toContain("model-b:free");
    expect(results).not.toContain("model-b");
  });

  it("falls back to hardcoded model when pool is empty", async () => {
    _setPoolForTests("standard", []);
    const result = await selectKidModel("standard", "game-empty-pool");
    // Falls back to selectModel("kid_family_chat", "standard") = "deepseek/deepseek-v4-flash"
    expect(result).toBe("deepseek/deepseek-v4-flash");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/kid-model-pool.test.ts`

Expected: FAIL — `hashGameId`, `selectKidModel`, `_resetPoolCacheForTests`, `_setPoolForTests` not exported from `model-config.ts`.

- [ ] **Step 3: Implement the pool selection logic**

Add to `server/src/llm/model-config.ts`:

```typescript
import { createHash } from "crypto";

export const KID_ROLES: ReadonlySet<LLMRole> = new Set([
  "kid_family_chat",
  "kid_sidebar",
  "kid_adult_chat",
]);

export interface PoolEntry {
  slug: string;
  freeSlug: string | null;
  weight: number;
}

interface PoolCache {
  models: PoolEntry[];
  totalWeight: number;
  fetchedAt: number;
}

const POOL_CACHE_TTL_MS = 5 * 60 * 1000;
const poolCacheByTier = new Map<ModelTier, PoolCache>();

// Test injection — allows tests to bypass the DB entirely.
const testPoolOverrides = new Map<ModelTier, PoolEntry[]>();

export function _resetPoolCacheForTests(): void {
  poolCacheByTier.clear();
  testPoolOverrides.clear();
}

export function _setPoolForTests(tier: ModelTier, entries: PoolEntry[]): void {
  testPoolOverrides.set(tier, entries);
  poolCacheByTier.delete(tier);
}

export function hashGameId(gameId: string, totalWeight: number): number {
  const hash = createHash("sha256").update(gameId).digest();
  return hash.readUInt32BE(0) % totalWeight;
}

async function getKidModelPool(
  tier: ModelTier
): Promise<{ models: PoolEntry[]; totalWeight: number }> {
  const override = testPoolOverrides.get(tier);
  if (override) {
    const totalWeight = override.reduce((s, e) => s + e.weight, 0);
    return { models: override, totalWeight };
  }

  const cached = poolCacheByTier.get(tier);
  if (cached && Date.now() - cached.fetchedAt < POOL_CACHE_TTL_MS) {
    return cached;
  }

  try {
    const { query } = await import("../db/pool.js");
    const { rows } = await query<{
      slug: string;
      free_slug: string | null;
      weight: number;
    }>(
      "SELECT slug, free_slug, weight FROM kid_model_pool WHERE tier = $1 AND active = true ORDER BY id",
      [tier]
    );
    const models: PoolEntry[] = rows.map((r) => ({
      slug: r.slug,
      freeSlug: r.free_slug,
      weight: r.weight,
    }));
    const totalWeight = models.reduce((s, e) => s + e.weight, 0);
    const entry: PoolCache = { models, totalWeight, fetchedAt: Date.now() };
    poolCacheByTier.set(tier, entry);
    return entry;
  } catch {
    // No DB (in-memory mode) or query error — fall back to empty pool
    return { models: [], totalWeight: 0 };
  }
}

export async function selectKidModel(
  tier: ModelTier,
  gameId: string
): Promise<string> {
  const pool = await getKidModelPool(tier);
  if (pool.models.length === 0 || pool.totalWeight === 0) {
    return selectModel("kid_family_chat", tier);
  }
  const target = hashGameId(gameId, pool.totalWeight);
  let cumulative = 0;
  for (const entry of pool.models) {
    cumulative += entry.weight;
    if (target < cumulative) {
      return entry.freeSlug ?? entry.slug;
    }
  }
  return pool.models[pool.models.length - 1].slug;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/kid-model-pool.test.ts`

Expected: All 6 tests PASS.

- [ ] **Step 5: Run existing model-config tests to confirm no regression**

Run: `cd server && npx vitest run tests/model-config.test.ts`

Expected: All existing tests PASS — `selectModel` is unchanged.

- [ ] **Step 6: Commit**

```bash
git add server/src/llm/model-config.ts server/tests/kid-model-pool.test.ts
git commit -m "feat(llm): add selectKidModel with weighted pool and gameId hash"
```

---

### Task 3: ChildSeedClient Wrapper

**Files:**
- Create: `server/src/llm/child-seed-client.ts`
- Create: `server/tests/child-seed-client.test.ts`

**Interfaces:**
- Consumes:
  - `LLMClient` interface from `server/src/llm/client.ts`
  - `selectKidModel(tier, gameId)` from Task 2
  - `KID_ROLES` from Task 2
  - `LLMRole`, `ModelTier` from `model-config.ts`
- Produces:
  - `ChildSeedClient` class implementing `LLMClient`
  - On kid roles, overrides model selection to use `selectKidModel`
  - On non-kid roles, delegates directly
  - Exposes `readonly gameId: string` and `readonly kidModel: string | null` for Langfuse tagging

- [ ] **Step 1: Write the failing tests**

Create `server/tests/child-seed-client.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/child-seed-client.test.ts`

Expected: FAIL — `ChildSeedClient` module does not exist.

- [ ] **Step 3: Implement ChildSeedClient**

Create `server/src/llm/child-seed-client.ts`:

```typescript
import type { LLMClient } from "./client.js";
import type { LLMRole, ModelTier } from "./model-config.js";
import { KID_ROLES, selectKidModel } from "./model-config.js";

/**
 * Wraps an LLMClient so kid roles use a model selected from the DB pool
 * based on the gameId. Non-kid roles pass through unchanged.
 *
 * The RoutingLLMClient underneath still handles provider routing, retries,
 * and failover — this wrapper only overrides WHICH model is selected for
 * kid calls, by resolving it before the inner client sees the role.
 *
 * Because RoutingLLMClient.streamResponse/completeResponse call
 * selectModel(role, tier) internally, we can't just pass a different role.
 * Instead, ChildSeedClient resolves the model slug and asks the inner
 * client to use it directly. This requires the inner client to support
 * model override — see the modelOverride parameter added to RoutingLLMClient.
 */
export class ChildSeedClient implements LLMClient {
  public kidModel: string | null = null;

  constructor(
    private readonly inner: LLMClient & { withModelOverride?: (model: string) => LLMClient },
    private readonly tier: ModelTier,
    public readonly gameId: string
  ) {}

  private async resolveKidModel(): Promise<string> {
    if (!this.kidModel) {
      this.kidModel = await selectKidModel(this.tier, this.gameId);
    }
    return this.kidModel;
  }

  private isKidRole(role?: LLMRole): boolean {
    return !!role && KID_ROLES.has(role);
  }

  async streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    if (this.isKidRole(role)) {
      const model = await this.resolveKidModel();
      const client =
        this.inner.withModelOverride?.(model) ?? this.inner;
      return client.streamResponse(system, messages, onChunk, role);
    }
    return this.inner.streamResponse(system, messages, onChunk, role);
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    if (this.isKidRole(role)) {
      const model = await this.resolveKidModel();
      const client =
        this.inner.withModelOverride?.(model) ?? this.inner;
      return client.completeResponse(system, userMessage, maxTokens, role, onChunk);
    }
    return this.inner.completeResponse(system, userMessage, maxTokens, role, onChunk);
  }

  async completeJson<T>(
    system: string,
    userMessage: string,
    role?: LLMRole,
    maxTokens?: number
  ): Promise<T> {
    if (this.isKidRole(role)) {
      const model = await this.resolveKidModel();
      const client =
        this.inner.withModelOverride?.(model) ?? this.inner;
      return client.completeJson<T>(system, userMessage, role, maxTokens);
    }
    return this.inner.completeJson<T>(system, userMessage, role, maxTokens);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/child-seed-client.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/llm/child-seed-client.ts server/tests/child-seed-client.test.ts
git commit -m "feat(llm): add ChildSeedClient for per-child model rotation"
```

---

### Task 4: RoutingLLMClient Model Override + Integration Wiring

**Files:**
- Modify: `server/src/llm/routing-client.ts` (add `withModelOverride` and `withChildSeed`)
- Modify: `server/src/app.ts` (expose `tier` on the engine dependency path)
- Modify: `server/src/socket/handlers.ts` (wrap `conversationEngine` per game)
- Modify: `server/src/observability/langfuse.ts` (thread `kidModel` metadata)
- Create: `server/tests/kid-model-routing.test.ts`

**Interfaces:**
- Consumes:
  - `ChildSeedClient` from Task 3
  - `RoutingLLMClient` from `routing-client.ts`
  - `TracedLLMClient` from `langfuse.ts`
  - `SocketDeps` from `handlers.ts`
- Produces:
  - `RoutingLLMClient.withModelOverride(model: string): LLMClient` — returns a copy that uses the given model slug instead of `selectModel` for the next call
  - `TracedLLMClient.withChildSeed(gameId: string): LLMClient` — creates a `ChildSeedClient` wrapping the traced client
  - Socket handlers wrap `conversationEngine.llm` per-game via `withChildSeed(game.id)`

- [ ] **Step 1: Write the failing integration test**

Create `server/tests/kid-model-routing.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { _resetPoolCacheForTests, _setPoolForTests } from "../src/llm/model-config.js";
import type { PoolEntry } from "../src/llm/model-config.js";
import { ChildSeedClient } from "../src/llm/child-seed-client.js";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMRole } from "../src/llm/model-config.js";

const pool: PoolEntry[] = [
  { slug: "alpha/model-a", freeSlug: null, weight: 1 },
  { slug: "beta/model-b", freeSlug: null, weight: 1 },
];

/** A mock that records which model override it received. */
function makeMockRoutingClient(): LLMClient & {
  lastOverride?: string;
  withModelOverride: (model: string) => LLMClient;
} {
  const mock: LLMClient & {
    lastOverride?: string;
    withModelOverride: (model: string) => LLMClient;
  } = {
    async streamResponse(_s, _m, onChunk, _r) { onChunk("ok"); return "ok"; },
    async completeResponse() { return "ok"; },
    async completeJson<T>() { return {} as T; },
    withModelOverride(model: string) {
      mock.lastOverride = model;
      return mock;
    },
  };
  return mock;
}

describe("kid model routing integration", () => {
  beforeEach(() => {
    _resetPoolCacheForTests();
    _setPoolForTests("standard", pool);
  });

  it("passes model override for kid_family_chat calls", async () => {
    const inner = makeMockRoutingClient();
    const client = new ChildSeedClient(inner, "standard", "game-route-1");
    await client.streamResponse("sys", [], () => {}, "kid_family_chat");
    expect(inner.lastOverride).toBeTruthy();
    expect(["alpha/model-a", "beta/model-b"]).toContain(inner.lastOverride);
  });

  it("does NOT pass model override for psychologist calls", async () => {
    const inner = makeMockRoutingClient();
    const client = new ChildSeedClient(inner, "standard", "game-route-2");
    await client.completeResponse("sys", "msg", 500, "psychologist");
    expect(inner.lastOverride).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/kid-model-routing.test.ts`

Expected: Tests should pass already since they use the mock — but they confirm the wiring contract. If `withModelOverride` on the mock is never called for psychologist, the test proves kid-only routing.

- [ ] **Step 3: Add `withModelOverride` to RoutingLLMClient**

In `server/src/llm/routing-client.ts`, add this method to the `RoutingLLMClient` class:

```typescript
/**
 * Returns a shallow copy that uses the given model slug instead of
 * selectModel() for the NEXT call on kid roles. Used by ChildSeedClient
 * to inject a pool-selected model without changing the LLMClient interface.
 */
withModelOverride(model: string): RoutingLLMClient {
  const clone = Object.create(this) as RoutingLLMClient;
  const originalSelectModel = selectModel;
  // Override the model resolution for kid roles only
  Object.defineProperty(clone, '_modelOverride', { value: model, writable: false });
  return clone;
}
```

Then modify `streamResponse` and `completeResponse` to check for `_modelOverride`:

At the top of `streamResponse`, replace:
```typescript
const slug = selectModel(resolvedRole, this.tier);
```
with:
```typescript
const slug = (this as any)._modelOverride ?? selectModel(resolvedRole, this.tier);
```

At the top of `completeResponse`, replace:
```typescript
const slug = selectModel(resolvedRole, this.tier);
```
with:
```typescript
const slug = (this as any)._modelOverride ?? selectModel(resolvedRole, this.tier);
```

- [ ] **Step 4: Add `withChildSeed` to TracedLLMClient**

In `server/src/observability/langfuse.ts`, add this import at the top:

```typescript
import { ChildSeedClient } from "../llm/child-seed-client.js";
```

Add this method to the `TracedLLMClient` class:

```typescript
/**
 * Returns a ChildSeedClient that rotates kid models based on gameId.
 * Non-kid calls pass through to this TracedLLMClient unchanged.
 */
withChildSeed(gameId: string): ChildSeedClient {
  const tier = this.tier ?? "standard";
  return new ChildSeedClient(this.inner, tier, gameId);
}
```

- [ ] **Step 5: Wire into socket handlers**

In `server/src/socket/handlers.ts`, the `conversationEngine` is a singleton shared across all games. The cleanest integration point is where `handleParentMessage` is called (around line 1135). The engine takes an `llm` client in its constructor, so we need a per-game engine.

Add this import at the top of `handlers.ts`:

```typescript
import { ConversationEngine } from "../game/conversation-engine.js";
```

In the `SocketDeps` interface, add:

```typescript
llm: import("../llm/client.js").LLMClient & { withChildSeed?: (gameId: string) => import("../llm/client.js").LLMClient };
```

Then, everywhere `conversationEngine` is used with a known `gameId`, create a per-game engine:

```typescript
// Replace: conversationEngine.handleParentMessage(state, ...)
// With:
const childLlm = deps.llm.withChildSeed?.(gameId) ?? conversationEngine.llm;
const gameEngine = new ConversationEngine(childLlm);
// Then use gameEngine instead of conversationEngine for this call
```

This is the most surgery-heavy step. The pattern is: anywhere `conversationEngine` touches a kid role for a specific game, use a game-scoped engine instead. The `endgameEngine` and non-kid calls (world_manager, psychologist, etc.) can keep using the singleton — `ChildSeedClient` passes those through unchanged anyway.

- [ ] **Step 6: Add `kidModel` to Langfuse trace metadata**

In `server/src/observability/langfuse.ts`, in the `TracedLLMClient.streamResponse` and `completeResponse` methods, check if the inner client is a `ChildSeedClient` and add its `kidModel` to the trace metadata:

```typescript
// After: const metadata = this.mergeRole(role);
// Add:
if (this.inner instanceof ChildSeedClient && this.inner.kidModel) {
  metadata.kidModel = this.inner.kidModel;
}
```

Update the `TraceMetadata` interface:

```typescript
export interface TraceMetadata {
  gameId?: string;
  eventNumber?: number;
  role?: string;
  kidModel?: string;
}
```

- [ ] **Step 7: Run the full test suite**

Run: `cd server && npx vitest run`

Expected: All tests PASS, including existing `model-config.test.ts`, new `kid-model-pool.test.ts`, new `child-seed-client.test.ts`, and new `kid-model-routing.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add server/src/llm/routing-client.ts server/src/observability/langfuse.ts \
       server/src/socket/handlers.ts server/src/app.ts \
       server/tests/kid-model-routing.test.ts
git commit -m "feat(llm): wire kid model rotation into routing, handlers, and Langfuse"
```

---

### Task 5: Model Search Benchmark Script

**Files:**
- Create: `scripts/model-search.ts`
- Modify: `.gitignore` (add `scripts/.prompt-cache/`)

**Interfaces:**
- Consumes:
  - Langfuse REST API (`langfuse.multiversegames.ai`) for prompt corpus
  - OpenRouter API (`openrouter.ai/api/v1`) for model calls
  - `kid_model_benchmarks` table from Task 1 via `pg`
- Produces:
  - Cached prompt corpus in `scripts/.prompt-cache/*.json`
  - Benchmark rows in `kid_model_benchmarks` table
  - Markdown comparison table on stdout

- [ ] **Step 1: Add `.prompt-cache/` to `.gitignore`**

Append to the project `.gitignore`:

```
# Model search prompt cache
scripts/.prompt-cache/
```

- [ ] **Step 2: Write the benchmark script**

Create `scripts/model-search.ts`. This is a long script — here is the complete implementation:

```typescript
/**
 * Model Search — benchmark candidate kid LLMs for personality diversity.
 *
 * Usage:
 *   npx tsx scripts/model-search.ts "qwen/qwen3.8-flash" "nvidia/nemotron-3.5-lightning:free"
 *   npx tsx scripts/model-search.ts                # re-display all previous results
 *
 * Requires: OPENROUTER_API_KEY env var
 * Optional: DATABASE_URL (for storing results in kid_model_benchmarks)
 *
 * Pulls 6 real kid_family_chat prompts from Langfuse (cached locally after
 * first run), runs each candidate model, scores responses for archetype
 * convergence, and prints a comparison table.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, ".prompt-cache");

// --- Langfuse prompt pulling ---

interface CachedPrompt {
  id: string;       // "age3_chat_1", "age7_chat_1", "age12_chat_1", etc.
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

const LANGFUSE_HOST = process.env.LANGFUSE_BASEURL ?? "https://langfuse.multiversegames.ai";
const LANGFUSE_PUBLIC = process.env.LANGFUSE_PUBLIC_KEY!;
const LANGFUSE_SECRET = process.env.LANGFUSE_SECRET_KEY!;
const LANGFUSE_AUTH = Buffer.from(`${LANGFUSE_PUBLIC}:${LANGFUSE_SECRET}`).toString("base64");

async function langfuseGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(path, LANGFUSE_HOST);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${LANGFUSE_AUTH}` },
  });
  if (!res.ok) throw new Error(`Langfuse ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pullPrompts(): Promise<CachedPrompt[]> {
  const cacheFile = join(CACHE_DIR, "prompts.json");
  if (existsSync(cacheFile)) {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  }

  console.log("Pulling prompts from Langfuse (first run)...");
  await mkdir(CACHE_DIR, { recursive: true });

  const targetAges = [3, 7, 12];
  const prompts: CachedPrompt[] = [];

  // Pull kid_family_chat observations, find ones at target ages
  const data = await langfuseGet("/api/public/observations", {
    type: "GENERATION",
    name: "kid_family_chat",
    limit: "500",
  }) as { data: Array<{ input: unknown; output: unknown }> };

  for (const age of targetAges) {
    // Find observations where the system prompt mentions the target age
    const agePattern = new RegExp(`(?:a|an) ${age}-year-old`);
    const matches = data.data.filter((obs) => {
      const input = obs.input as { system?: string } | undefined;
      return input?.system && agePattern.test(input.system);
    });

    if (matches.length === 0) {
      console.warn(`No observations found for age ${age}`);
      continue;
    }

    // Take the first 2 matches per age for variety
    for (let i = 0; i < Math.min(2, matches.length); i++) {
      const obs = matches[i];
      const input = obs.input as { system: string; messages?: Array<{ role: string; content: string }> };
      prompts.push({
        id: `age${age}_chat_${i + 1}`,
        system: input.system,
        messages: (input.messages ?? [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-3) as Array<{ role: "user" | "assistant"; content: string }>,
      });
    }
  }

  await writeFile(cacheFile, JSON.stringify(prompts, null, 2));
  console.log(`Cached ${prompts.length} prompts to ${cacheFile}`);
  return prompts;
}

// --- Scoring ---

const SENSORY_WORDS = /\b(scratchy|buzzy|sticky|loud|sharp|wobbly|heavy|tight|fast|cold|prickly|itchy|rough|smooth|squish|crunch|tingle|hum|buzz|rumble)\b/gi;
const GRANDMA_PATTERN = /\b(grandma|grammy|nana|grandmother|gran|granny)\b/i;
const HELEN_PATTERN = /\bgrandma\s*helen\b|\bhelen\b.*\bgrandma\b/i;
const TEACHER_PATTERN = /\b(mrs?\.\s*gable|mrs?\.\s*patterson|teacher.*sigh|teacher.*referral)\b/i;
const AUNT_PATTERN = /\b(aunt|auntie)\s+\w+/i;

const ORDER_COPING = /\b(lin(e|ing)\s*up|measur|count|exact|precise|gap|straight|order|arrange|sort)\b/i;
const FREEZE_COPING = /\b(freeze|froze|frozen|blank\s*face|going?\s*still|stone|rock|stiff|locked)\b/i;
const NEGOTIATE_COPING = /\b(trade|deal|bargain|negotiate|swap|offer|exchange|if\s*(?:you|I)\s*(?:do|give))\b/i;
const CREATE_COPING = /\b(cook|bake|draw|paint|build|make|craft|create|garden|plant)\b/i;

interface BenchmarkResult {
  modelSlug: string;
  promptId: string;
  sensoryScore: number;
  castScore: number;
  copingArchetype: string;
  englishQuality: boolean;
  responseTokens: number;
  costUsd: number;
  rawExcerpt: string;
}

function scoreResponse(text: string): Omit<BenchmarkResult, "modelSlug" | "promptId" | "responseTokens" | "costUsd"> {
  const words = text.split(/\s+/).length;

  // Sensory score: count of sensory words / total words, capped at 1.0
  const sensoryMatches = text.match(SENSORY_WORDS) ?? [];
  const sensoryScore = Math.min(1.0, sensoryMatches.length / Math.max(words, 1) * 10);

  // Cast score: 0.25 per archetype element present
  let castScore = 0;
  if (GRANDMA_PATTERN.test(text)) castScore += 0.25;
  if (HELEN_PATTERN.test(text)) castScore += 0.25;
  if (TEACHER_PATTERN.test(text)) castScore += 0.25;
  if (AUNT_PATTERN.test(text)) castScore += 0.25;

  // Coping archetype
  let copingArchetype = "other";
  if (ORDER_COPING.test(text)) copingArchetype = "ordering";
  else if (FREEZE_COPING.test(text)) copingArchetype = "freezing";
  else if (NEGOTIATE_COPING.test(text)) copingArchetype = "negotiating";
  else if (CREATE_COPING.test(text)) copingArchetype = "creating";

  // English quality: check for CJK characters (common with Qwen/DeepSeek)
  const cjkChars = text.match(/[一-鿿㐀-䶿]/g) ?? [];
  const englishQuality = cjkChars.length < 3;

  return {
    sensoryScore: Math.round(sensoryScore * 100) / 100,
    castScore,
    copingArchetype,
    englishQuality,
    rawExcerpt: text.slice(0, 500),
  };
}

// --- Model calling ---

async function callModel(
  client: OpenAI,
  model: string,
  prompt: CachedPrompt
): Promise<{ text: string; tokens: number; cost: number }> {
  const msgs: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: prompt.system },
    ...prompt.messages,
  ];
  if (prompt.messages.length === 0 || prompt.messages[prompt.messages.length - 1].role !== "user") {
    msgs.push({ role: "user", content: "(The child looks at their parents, waiting.)" });
  }

  try {
    const response = await client.chat.completions.create(
      { model, messages: msgs, max_tokens: 500 },
      { signal: AbortSignal.timeout(60_000) }
    );
    const text = response.choices[0]?.message?.content ?? "";
    const tokens = response.usage?.completion_tokens ?? 0;
    const cost = typeof (response.usage as any)?.cost === "number" ? (response.usage as any).cost : 0;
    return { text, tokens, cost };
  } catch (e) {
    console.error(`  ERROR calling ${model}: ${e}`);
    return { text: "", tokens: 0, cost: 0 };
  }
}

// --- DB storage ---

async function storeResult(result: BenchmarkResult): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO kid_model_benchmarks
         (model_slug, prompt_id, sensory_score, cast_score, coping_archetype,
          english_quality, response_tokens, cost_usd, raw_excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        result.modelSlug, result.promptId, result.sensoryScore,
        result.castScore, result.copingArchetype, result.englishQuality,
        result.responseTokens, result.costUsd, result.rawExcerpt,
      ]
    );
  } finally {
    await pool.end();
  }
}

// --- Main ---

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY not set");
    process.exit(1);
  }

  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    defaultHeaders: {
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "RI Model Search",
    },
  });

  const models = process.argv.slice(2);
  const prompts = await pullPrompts();

  if (models.length === 0) {
    console.log("No models specified. Pass model slugs as arguments.");
    console.log("Example: npx tsx scripts/model-search.ts 'qwen/qwen3.8-flash' 'nvidia/nemotron-3.5-lightning:free'");
    process.exit(0);
  }

  console.log(`\nBenchmarking ${models.length} models x ${prompts.length} prompts = ${models.length * prompts.length} calls\n`);

  const results: BenchmarkResult[] = [];

  for (const model of models) {
    console.log(`\n--- ${model} ---`);
    for (const prompt of prompts) {
      process.stdout.write(`  ${prompt.id}: `);
      const { text, tokens, cost } = await callModel(client, model, prompt);
      if (!text) { console.log("EMPTY"); continue; }

      const scores = scoreResponse(text);
      const result: BenchmarkResult = {
        modelSlug: model,
        promptId: prompt.id,
        responseTokens: tokens,
        costUsd: cost,
        ...scores,
      };
      results.push(result);
      await storeResult(result);
      console.log(
        `sensory=${scores.sensoryScore} cast=${scores.castScore} ` +
        `coping=${scores.copingArchetype} eng=${scores.englishQuality ? "OK" : "FAIL"}`
      );
    }
  }

  // --- Summary table ---
  console.log("\n\n## Model Comparison\n");
  console.log("| Model | Avg Sensory | Avg Cast | Coping | English | Diversity |");
  console.log("|-------|-------------|----------|--------|---------|-----------|");

  const byModel = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    if (!byModel.has(r.modelSlug)) byModel.set(r.modelSlug, []);
    byModel.get(r.modelSlug)!.push(r);
  }

  for (const [model, runs] of byModel) {
    const avgSensory = runs.reduce((s, r) => s + r.sensoryScore, 0) / runs.length;
    const avgCast = runs.reduce((s, r) => s + r.castScore, 0) / runs.length;
    const copings = [...new Set(runs.map((r) => r.copingArchetype))].join("/");
    const engOk = runs.every((r) => r.englishQuality);
    // Diversity = inverse of archetype match (lower sensory + lower cast = more diverse)
    const diversity = Math.round((1 - (avgSensory + avgCast) / 2) * 100);
    console.log(
      `| ${model} | ${avgSensory.toFixed(2)} | ${avgCast.toFixed(2)} | ${copings} | ${engOk ? "OK" : "FAIL"} | ${diversity}% |`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Test the script runs (dry run)**

Run: `cd games/raising-intelligences && OPENROUTER_API_KEY=$OPENROUTER_API_KEY npx tsx scripts/model-search.ts`

Expected: Prints usage message (no models specified). Confirms the script compiles and runs.

- [ ] **Step 4: Run against one cheap model to verify end-to-end**

Run: `cd games/raising-intelligences && OPENROUTER_API_KEY=$OPENROUTER_API_KEY npx tsx scripts/model-search.ts "deepseek/deepseek-v4-flash-0731"`

Expected: Pulls prompts from Langfuse (or cache), calls the model 6 times, prints scored results and summary table.

- [ ] **Step 5: Commit**

```bash
git add scripts/model-search.ts .gitignore
git commit -m "feat(scripts): add model-search benchmark harness for kid LLM diversity"
```

---

### Task 6: Run Full Benchmark + Seed Pool

**Files:**
- No new files — this task runs the benchmark script against all candidates and populates the pool

**Interfaces:**
- Consumes: `scripts/model-search.ts` from Task 5, `kid_model_pool` table from Task 1
- Produces: Benchmark results in `kid_model_benchmarks`, initial pool entries in `kid_model_pool`

- [ ] **Step 1: Run the full benchmark**

Run the benchmark against all candidate models:

```bash
cd games/raising-intelligences && \
OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
DATABASE_URL=$DATABASE_URL \
npx tsx scripts/model-search.ts \
  "deepseek/deepseek-v4.1-flash" \
  "qwen/qwen3.8-flash" \
  "qwen/qwen3.8-27b:free" \
  "nvidia/nemotron-3.5-lightning:free" \
  "upstage/solar-pro4" \
  "thinkingmachines/inkling-small:free" \
  "poolside/laguna-s-2.1:free" \
  "z-ai/glm-5.3-flash" \
  "deepseek/deepseek-v4-flash-0731" \
  "xiaomi/mimo-v2.5" \
  "tencent/hy3" \
  "minimax/minimax-m3" \
  "inclusionai/ling-3.0-flash-fin:free" \
  "stealth/union-alpha" \
  "dots-studio/dots-3-note-preview:free"
```

Expected: A markdown table comparing all models on sensory score, cast score, coping archetype, English quality, and diversity %.

- [ ] **Step 2: Review results and select pool winners**

From the benchmark output, select models that:
1. Pass English quality (no CJK leakage)
2. Score below 0.4 on average sensory (not converging to the same archetype)
3. Score below 0.25 on average cast (not generating Grandma Helen)
4. Produce a different coping archetype than "ordering"/"freezing"

These are the diversity winners. Also keep the current model (`deepseek/deepseek-v4-flash`) as the baseline.

- [ ] **Step 3: Seed the pool with winners**

Connect to the production database and insert the winning models:

```sql
-- Example (actual models depend on benchmark results):
INSERT INTO kid_model_pool (slug, free_slug, tier, weight) VALUES
  ('deepseek/deepseek-v4-flash', NULL, 'standard', 1),
  -- Add each winner with weight 1 to start even distribution
  ('winner-1/model', 'winner-1/model:free', 'standard', 1),
  ('winner-2/model', NULL, 'standard', 1),
  ('winner-3/model', NULL, 'standard', 1);
```

- [ ] **Step 4: Verify pool query works**

```sql
SELECT slug, free_slug, weight FROM kid_model_pool WHERE tier = 'standard' AND active = true ORDER BY id;
```

Expected: All inserted models listed with correct slugs and weights.

- [ ] **Step 5: No commit needed** — pool data is in the DB, not in code.
