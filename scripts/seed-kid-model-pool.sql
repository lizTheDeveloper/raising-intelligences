-- Initial kid model pool — 4 models from benchmark (2026-09-19)
-- Run against production DB: psql $DATABASE_URL -f scripts/seed-kid-model-pool.sql
--
-- Pool is additive — re-running is safe (ON CONFLICT skips duplicates).
--
-- deepseek/deepseek-v4-flash is deliberately excluded: it's the hardcoded
-- STANDARD_MODELS.kid_family_chat fallback (model-config.ts) that
-- selectKidModel() already returns whenever the pool is empty/unconfigured.
-- Including it here would waste one of the rotation slots on a model kids
-- already get by default.

INSERT INTO kid_model_pool (slug, free_slug, tier, weight) VALUES
  ('deepseek/deepseek-v4.1-flash', NULL, 'standard', 1),
  ('upstage/solar-pro4', NULL, 'standard', 1),
  ('xiaomi/mimo-v2.5', NULL, 'standard', 1),
  ('minimax/minimax-m3', NULL, 'standard', 1)
ON CONFLICT (slug, tier) DO NOTHING;
