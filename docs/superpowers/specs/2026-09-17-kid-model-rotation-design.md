# Kid Model Rotation — Design Spec

**Date:** 2026-09-17
**Status:** Draft
**Motivation:** Devlog analysis of 438 childhoods found 80% converge on one archetype (sensory-sensitive, order-needing, critical grandmother, quiet-room career). Rotating the kid LLM across models from different families should produce genuine personality diversity.

## Overview

Two deliverables:

1. **Model Search Pipeline** — a kept script + DB table for benchmarking candidate models against real kid prompts and scoring their personality diversity.
2. **DB-Configurable Model Pool** — production model rotation with sticky per-child assignment via gameId hash.

## 1. Model Search Pipeline

### Script: `scripts/model-search.ts`

A CLI tool that benchmarks candidate models for kid_family_chat quality and diversity.

**Usage:**
```bash
npx tsx scripts/model-search.ts "qwen/qwen3.8-flash" "nvidia/nemotron-3.5-lightning:free"
# Or with no args to re-score all previously benchmarked models
npx tsx scripts/model-search.ts
```

**Prompt corpus:**
Pull 6 representative prompts from Langfuse via the REST API:
- Age 3 system prompt + 3 parent messages (toddler baseline)
- Age 7 system prompt + 3 parent messages (middle childhood)
- Age 12 system prompt + 3 parent messages (the "armor year" — strongest convergence)

Each prompt is a real `kid_family_chat` observation from production. The script caches prompts locally after the first pull (`scripts/.prompt-cache/`) so Langfuse isn't hit on every run.

**Per-model scoring (automated):**
For each model x prompt pair, score the response on:

| Metric | Method | Range |
|--------|--------|-------|
| `sensory_score` | Regex count of archetype sensory words (scratchy, buzzy, sticky, loud, sharp, wobbly, heavy, tight, fast, cold) normalized by response length | 0.0 - 1.0 |
| `cast_score` | Binary flags: mentions grandmother/grammy/nana (0.25), Helen specifically (0.25), Mrs. Gable or similar teacher (0.25), aunt figure (0.25) | 0.0 - 1.0 |
| `coping_archetype` | Classify into: "ordering" (lining up, measuring, counting), "freezing" (blank face, going still), "negotiating" (trading, deal-making), "creating" (cooking, building, drawing), "other" | categorical |
| `english_quality` | Check for non-English tokens, incoherent output, breaking character | pass/fail |

A high `sensory_score` + high `cast_score` + "ordering"/"freezing" coping = convergent archetype. Low scores or different coping = diversity signal.

**Output:**
- Results stored in `kid_model_benchmarks` table
- Markdown comparison table printed to stdout
- Models ranked by "diversity score" (inverse of archetype match)

### DB Table: `kid_model_benchmarks`

```sql
CREATE TABLE kid_model_benchmarks (
  id              serial PRIMARY KEY,
  model_slug      text NOT NULL,
  prompt_id       text NOT NULL,        -- "age3_chat", "age7_chat", "age12_chat" etc.
  sensory_score   real,
  cast_score      real,
  coping_archetype text,
  english_quality  boolean NOT NULL DEFAULT true,
  response_tokens  int,
  cost_usd         real,
  raw_excerpt      text,                -- first 500 chars of response (for manual review)
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_benchmarks_model ON kid_model_benchmarks(model_slug);
```

## 2. DB-Configurable Model Pool

### DB Table: `kid_model_pool`

```sql
CREATE TABLE kid_model_pool (
  id          serial PRIMARY KEY,
  slug        text NOT NULL,            -- paid model: "qwen/qwen3.8-flash"
  free_slug   text,                     -- free tier: "qwen/qwen3.8-27b:free" (nullable)
  tier        text NOT NULL DEFAULT 'standard',  -- "standard" | "cerebras" | "premium"
  weight      int NOT NULL DEFAULT 1,   -- relative frequency in pool
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(slug, tier)
);
```

**Weight mechanics:** A model with weight 2 gets twice as many children as weight 1. Useful for promoting a model that benchmarked well or dampening one that's producing quality issues.

**Seed data** (after benchmarks confirm quality):
```sql
INSERT INTO kid_model_pool (slug, free_slug, tier, weight) VALUES
  ('deepseek/deepseek-v4.1-flash', NULL, 'standard', 1),
  ('qwen/qwen3.8-flash', NULL, 'standard', 1),
  -- ... winners from benchmark ...
```

### Selection Logic: `selectKidModel(tier, gameId)`

In `model-config.ts`:

```typescript
import { createHash } from "crypto";

// Cached pool, refreshed every 5 minutes
let poolCache: { models: PoolEntry[]; totalWeight: number; fetchedAt: number } | null = null;
const POOL_CACHE_TTL_MS = 5 * 60 * 1000;

interface PoolEntry {
  slug: string;
  freeSlug: string | null;
  weight: number;
}

async function getPool(tier: ModelTier): Promise<{ models: PoolEntry[]; totalWeight: number }> {
  if (poolCache && Date.now() - poolCache.fetchedAt < POOL_CACHE_TTL_MS) {
    return poolCache;
  }
  // Query kid_model_pool WHERE tier = $1 AND active = true ORDER BY id
  // Cache result with timestamp
  // If empty (no DB, no rows), fall back to current hardcoded model
}

function hashGameId(gameId: string, totalWeight: number): number {
  const hash = createHash("sha256").update(gameId).digest();
  const uint32 = hash.readUInt32BE(0);
  return uint32 % totalWeight;
}

export async function selectKidModel(tier: ModelTier, gameId: string): Promise<string> {
  const pool = await getPool(tier);
  if (pool.models.length === 0) return selectModel("kid_family_chat", tier); // fallback
  
  const target = hashGameId(gameId, pool.totalWeight);
  let cumulative = 0;
  for (const entry of pool.models) {
    cumulative += entry.weight;
    if (target < cumulative) {
      return entry.freeSlug ?? entry.slug;
    }
  }
  return pool.models[pool.models.length - 1].slug; // shouldn't reach, but safe
}
```

### Integration: `withChildSeed(gameId)`

Add to `RoutingLLMClient`:

```typescript
withChildSeed(gameId: string): LLMClient {
  return new ChildSeedClient(this, gameId);
}
```

`ChildSeedClient` is a thin wrapper that:
- For kid roles (`kid_family_chat`, `kid_sidebar`, `kid_adult_chat`): calls `selectKidModel(tier, gameId)` instead of `selectModel(role, tier)`
- For all other roles: delegates directly to the inner client unchanged
- Implements the same `LLMClient` interface

### Integration: Conversation Engine

In the socket handler where `handleParentMessage` is called, the `llm` client is already available. Wrap it:

```typescript
const childLlm = llm.withChildSeed(game.id);
const engine = new ConversationEngine(childLlm);
```

This is the only callsite change. The engine, context assembler, and safety systems are unaffected.

### Free-Tier Fallback

When `free_slug` is set, the routing client tries it first. On OpenRouter 429 (rate limit) or 404 (model removed), it falls back to `slug` and logs:

```typescript
logger.warn("kid_model_free_tier_fallback", {
  gameId,
  from: freeSlug,
  to: slug,
});
```

This reuses the existing rate-limit fallback pattern in `RoutingLLMClient`.

### Langfuse Tagging

The `TracedLLMClient` already carries metadata. Add `kidModel` to the trace metadata when `withChildSeed` is active:

```typescript
// In ChildSeedClient, after resolving the model:
this.inner.withMetadata({ kidModel: resolvedSlug })
```

This makes the model slug queryable in Langfuse, so future census pulls can segment children by model and measure whether diversity actually improved.

## Files Changed

| File | Change |
|------|--------|
| `scripts/model-search.ts` | New — benchmark harness |
| `scripts/.prompt-cache/` | New — cached Langfuse prompts (gitignored) |
| `src/db/migrate.ts` | Add `kid_model_benchmarks` and `kid_model_pool` tables |
| `src/llm/model-config.ts` | Add `selectKidModel()`, `PoolEntry`, pool cache |
| `src/llm/routing-client.ts` | Add `withChildSeed()` method, `ChildSeedClient` class |
| `src/llm/client.ts` | No change — `LLMClient` interface is unchanged |
| `src/socket/handlers.ts` | Wrap `llm` with `.withChildSeed(game.id)` for kid calls |
| `src/observability/langfuse.ts` | Thread `kidModel` metadata from ChildSeedClient |
| `tests/model-config.test.ts` | Test hash determinism, pool fallback, weight distribution |
| `tests/kid-model-rotation.test.ts` | New — integration test for ChildSeedClient routing |

## What This Does NOT Change

- Non-kid roles (psychologist, world_manager, epilogue, etc.) — unchanged
- Safety models — unchanged, always `claude-haiku-4-5`
- The `LLMClient` interface — unchanged, no downstream breakage
- Premium/Cerebras tiers — can have their own pools later, but start with standard only
- Existing games in progress — may rehash to a different model on pool changes, which is fine (personality is prompt-driven, not model-driven)

## Candidate Models (Initial Benchmark Run)

```
deepseek/deepseek-v4.1-flash
qwen/qwen3.8-flash
qwen/qwen3.8-27b:free          (paid: qwen/qwen3.8-27b)
nvidia/nemotron-3.5-lightning:free  (paid: nvidia/nemotron-3.5-lightning)
upstage/solar-pro4
thinkingmachines/inkling-small:free (paid too expensive, free only)
poolside/laguna-s-2.1:free      (paid later)
z-ai/glm-5.3-flash
deepseek/deepseek-v4-flash-0731
xiaomi/mimo-v2.5
tencent/hy3
minimax/minimax-m3
inclusionai/ling-3.0-flash-fin:free (paid too expensive, free only)
stealth/union-alpha             (free model)
dots-studio/dots-3-note-preview:free
```

## Success Criteria

1. Model search script runs and produces a scored comparison of all candidate models
2. At least 3 models from different families score "non-convergent" and pass English quality
3. Production children assigned to different models show measurably different archetype scores in the next Langfuse census (2-4 weeks after deploy)
