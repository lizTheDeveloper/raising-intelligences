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
