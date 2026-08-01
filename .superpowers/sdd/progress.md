# SDD Progress Ledger — Dark Play Plan 4 (escalation detection, FLAG-ONLY)

Plan: docs/superpowers/plans/2026-07-30-dark-play-plan4-escalation-detection.md
Branch: feat/dark-play-plan4  (base: a136dd9)
Started: 2026-07-31
Liz decision: FLAG-FOR-REVIEW-ONLY (no auto-ban). Task 4 auto-ban wiring DROPPED.
Execution: single implementer for the cohesive server-only plan + focused review of isEscalation/getIpPlayProfile + no-banIp before deploy.

## Tasks
- [x] T1: record IP on games (migration 017) — `repo.recordGameIp`, called at both creation sites (routes/game.ts POST /game, socket/handlers.ts CREATE_GAME) right after saveGame.
- [x] T2: getIpPlayProfile + isEscalation ratio predicate — `server/src/safety/escalation.ts`; predicate requires `ordinaryGames === 0 && darkGames === totalGames && totalGames >= ESCALATION_MIN_GAMES`. Exhaustive unit tests + in-memory repo integration tests in `tests/escalation.test.ts`.
- [x] T3: evaluate on scene-end + escalation_flags record (FLAG ONLY, no ban) — migration 018, `evaluateEscalation` wired into both scene-end seams (routes/game.ts /end-chat, socket/handlers.ts endChat) only on Tier A "concern", after recordConcern, `.catch`-wrapped. Dedup via `hasEscalationFlagForIp`.
- [x] T4 (verification only — auto-ban wiring correctly NOT implemented per Liz's flag-only decision): `npx tsc -b server` exit 0; `npm run test -w server` 35 files / 267 tests green; grepped full diff — no `banIp`/`applyModerationBlock` call added anywhere for escalation. Deploy step left to the standard merge → deploy.sh flow, not run from this session.
Plan 4: complete (flag-only). 267 tests (16 new incl. exoneration case), tsc 0. isEscalation requires ordinaryGames===0 denominator (verified). NO banIp added (grep-verified). Wired fire-and-forget on concern scene-ends.
