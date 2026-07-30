# SDD Progress Ledger — Dark Play Plan 2 (concern accumulator)

Plan: docs/superpowers/plans/2026-07-30-dark-play-plan2-concern-accumulator.md
Branch: feat/dark-play-plan2  (base: 9571e68)
Started: 2026-07-30
Execution: direct implementation (fully-specified mechanical plan) + final reviewer subagent before deploy.

## Tasks
- [ ] Task 1: concernLevel field + constants + concernDeltaForTier + CONCERN_ACCRUED reducer
- [ ] Task 2: persist concernLevel (migration 015 + repo save/load)
- [ ] Task 3: wire scene-end accrual into both endChat paths (socket + REST)
