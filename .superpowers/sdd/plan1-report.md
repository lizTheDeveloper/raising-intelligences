# Plan 1 (classifier reroute) — Implementation Report

**Plan:** `docs/superpowers/plans/2026-07-29-dark-play-plan1-classifier-reroute.md`
**Branch:** `feat/dark-play-plan1` (base `origin/main` @ `b065f8d`)
**Status:** DONE

## Commit range

`99a733f..f92bcfa` (7 commits: Tasks 1–4 + Task 6 + ledger update + this report; Task 5 is verification-only, no commit)

```
99a733f feat(safety): three-outcome scene classifier (block/concern/none) replacing boolean grooming flag
d299a94 feat(safety): recordConcern + concern_events table (Tier A, never bans)
b9d72fe feat(safety): route scene classifier — block bans, concern records + continues
39f1377 test(safety): regression — concern keeps session alive, block terminates + bans
8230875 chore(safety): script to reverse false-positive repeat-offender bans (dry-run default)
007cb4d docs: check off Plan 1 tasks in the SDD progress ledger
f92bcfa docs: Plan 1 implementation report
```

## Verification (final)

- `npx tsc -b server`: exit 0
- `npm run test -w server`: **24 test files, 201 tests, all passing**
- `npm run build -w client`: succeeds (vite build OK)

## Confirmed-against-reality items (as flagged by the plan)

1. **Banned-IP accessor name**: `repository.ts` already uses `isIpBanned(ipAddress): Promise<boolean>` verbatim (both `PgGameRepository` and `InMemoryGameRepository`) — no adjustment needed to the plan's test code.
2. **`banned_ips` table**: columns are `ip_address`, `reason`, `created_at` as the plan assumed (migration `011-safety-moderation.sql`) — the Task 6 script's SQL is correct as given.
3. Repo-wide grep for `detectGroomingPattern|groomingCheck` after Task 3: clean (also grepped `\.abuse\b` since that field was renamed too — see deviation below).

## Deviations from the plan (all necessary for a tsc-clean, behavior-consistent result)

1. **`server/src/routes/game.ts` (REST route) was not in the plan's file list but had to be fixed.** It's a second, independent mirror of both call sites the plan describes in `handlers.ts`:
   - The mid-scene interception in the `/game/:id/message` handler (`result.abuse` fed by `handleParentMessage`).
   - The `/game/:id/end-chat` handler (`groomingCheck` fed by `endFamilyChat`).
   Both called the now-removed `detectGroomingPattern` / read the old shape directly, so leaving them alone would have broken `tsc -b server`. Rerouted both using the identical block/concern pattern used in `handlers.ts` (block → `applyModerationBlock` with `banIp: true`, concern → `recordConcern` + continue). Committed together with Task 3 (`b9d72fe`).

2. **`ConversationEngine.handleParentMessage`'s mid-scene check** (in `conversation-engine.ts`) also called `detectGroomingPattern` directly and returned `abuse?: ModerationResult`. The plan's Task 3 only spelled out `endFamilyChat`'s rename. Renamed/retyped this to `sceneSafety?: SceneSafetyResult`, populated whenever `tier !== "none"` (not just on a would-have-been-`flagged`), and rerouted both `handlers.ts` and `routes/game.ts` callers to treat `"block"` as immediate termination+ban and `"concern"` as record-and-continue (falls through to normal message flow — verified no stray `return` swallows the kid's turn).

3. **Postgres repo methods use `this.db.query(...)`**, not a standalone `query()` function as the plan's snippet showed — matched the file's actual pattern (mirrors `saveModerationFlag`/`isIpBanned` exactly).

4. **`pattern-detection.test.ts`** needed an added `import { MockLLMClient } from "../src/llm/mock.js"` — the file previously only used a local `stubLLM` helper; the plan's Step 2 test snippet assumes `MockLLMClient` is already imported. Added it; the pre-existing `stubLLM` helper is retained for the untouched `detectConcerningTrajectory` tests.

5. **`ModerationResult` import dropped from `conversation-engine.ts`** — became unused once both fields it typed (`abuse`, `groomingCheck`) were retyped to `SceneSafetyResult`.

## Not done / explicitly skipped per instructions

- **Task 6 Step 2 (dry-run against prod)** was not executed. No `DATABASE_URL` was configured in this worktree, and the task explicitly said not to touch prod / not to run the reversal "for real" — the prod reversal was already done manually. The script was syntax-checked (`node --check`) only.
- No deploy was performed (Task 5's note says leave committed on `main`-bound branch; not deploying per instructions).
- Did not push the branch (not requested).

## Notable side-effect flagged for Plan 2 (accumulator)

Both the mid-scene checkpoint and end-of-scene check now call `classifyScene` → can each independently call `recordConcern`, so a single scene can produce more than one `concern_events` row (once per checkpoint that returns "concern", plus once at scene end). This is harmless for Plan 1 (no de-dupe logic exists or is needed yet) but the Plan 2 concern-accumulator should account for multiple concern rows per scene, not assume one-per-scene.

## Files touched

- `server/src/safety/moderation.ts` — `SceneSafetyTier`/`SceneSafetyResult` types, `recordConcern`
- `server/src/safety/pattern-detection.ts` — `classifyScene` replacing `detectGroomingPattern`
- `server/src/llm/mock.ts` — retyped `groomingResult`, added `throwOnSafetyCheck`
- `server/src/db/migrations/014-concern-events.sql` — new table
- `server/src/db/repository.ts` — `saveConcernEvent`/`loadConcernEvents` (interface + Pg + in-memory)
- `server/src/game/conversation-engine.ts` — `endFamilyChat` + `handleParentMessage` rerouted
- `server/src/socket/handlers.ts` — both call sites rerouted
- `server/src/routes/game.ts` — both call sites rerouted (plan omission, fixed)
- `scripts/reverse-false-positive-bans.mjs` — new remediation script (uncommitted-to-run)
- Tests: `server/tests/pattern-detection.test.ts`, `server/tests/moderation.test.ts`, `server/tests/conversation-engine.test.ts`, `server/tests/dark-play-reroute.test.ts` (new)
- `.superpowers/sdd/progress.md` — checked off
