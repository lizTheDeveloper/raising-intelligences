# Dark Play — Plan 4: Escalation Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Detect the one bad-faith pattern the rest of the Dark Play system deliberately does NOT catch — an actor who *only ever* drives toward dark material across *many* games, never exploring RI's range — and respond, without re-creating the false-ban vector that Plan 1 had to clean up.

**Architecture:** The signal is a **ratio, never a raw count**: `dark games ÷ total games` for an IP, gated by an **ordinary-play denominator** (does this IP ever play normally?). A good-faith player who explores dark themes is exonerated by their ordinary play; only an IP whose *every* game is dark with *zero* range trips the signal. Because that denominator requires knowing all of an IP's games — and `games` currently has no IP column (only the dark-event tables `moderation_flags`/`concern_events` carry `ip_address`, so an IP's clean games are invisible) — Task 1 records IP on `games`. The escalation **action is reviewable, never a silent permanent ban** (see Global Constraints / open decision).

**Tech Stack:** TypeScript (Node/Express + socket.io), Postgres via `pg`, Vitest. No new dependencies.

## Why the naive signal is wrong (read before implementing)

- The reliable per-message `sexual/minors` check (`moderateParentMessage` → `applyModerationBlock`, default `banIp: true`) **bans on the first occurrence**. So "N games with a Tier-B sexualization event" is not an accumulable signal — the first event already banned the IP. Nothing to escalate there.
- The only *unbanned* dark signals across games are the scene-level block flags (`moderation_flags`, `banIp:false` under the N-1 policy) and concern events (`concern_events`). A **raw count** of distinct games in *either* table is exactly the shape of the old `repeat-offender` rule that auto-banned good-faith parents (the 10 bans Plan 1 reversed). Do NOT build a raw-count escalation.
- The safe signal is a **ratio with an ordinary-play denominator**. "Dark across many games AND never any ordinary play" is what distinguishes bad faith from a good-faith explorer. That is what this plan builds.

## Global Constraints

- **Ratio, never raw count.** The escalation predicate MUST include an ordinary-play denominator. No code path may escalate on "flagged/concerning in ≥N games" alone.
- **Reviewable, not silent.** Escalation produces a persisted, evidence-carrying record for human review (game ids, the play profile, timestamps). Whether it ALSO auto-bans is the single open decision (below); default in this plan is **flag-for-review only** (no auto-ban) given the fresh false-ban history. If auto-ban is chosen, it MUST be logged with the evidence and be one-command reversible (mirror the existing `unbanIp` + the `scripts/reverse-false-positive-bans.mjs` pattern).
- **High, documented thresholds.** `ESCALATION_MIN_GAMES = 5` (an IP must have this many games before the signal can fire), and the predicate requires `ordinaryGames === 0` AND `darkGames === totalGames`. All tunable, in one place.
- **Never touches the ladder's healing path.** This plan does not change concern accrual, the rungs, or removal. It only adds a cross-game read + an escalation record.
- **Server-only.** No new field crosses to clients.
- Spec: `docs/superpowers/specs/2026-07-29-dark-play-consequences-design.md` §8. Builds on Plans 1–3 (`concernLevel`, `highestRungFired`, `moderation_flags`, `banned_ips`, `unbanIp`).

## OPEN DECISION for the review gate (surface to Liz before building)

Liz selected "escalation → ban," but her option's literal signal ("N games with a sexual/minors event, never the scene-flag count") is unbuildable (see "Why the naive signal is wrong"). This plan implements the buildable, safe reduction of her intent — **dark-only ÷ no-range ratio**. One knob remains, and it is the highest-regret one in the whole four-plan arc:

- **(A) Flag-for-human-review only (this plan's default):** escalation writes an `escalation_flags` record with full evidence; a human decides whether to ban. Zero risk of a false auto-ban; requires someone to watch the queue.
- **(B) Auto-ban + evidence + easy reversal:** escalation also calls `banIp` with a logged reason and the evidence attached; reversible via the existing unban path. Stronger deterrent; carries auto-ban regret given we just reversed 10.

Recommendation: ship **(A)** first, watch what it flags in production, promote to **(B)** only if the flags prove clean. Confirm with Liz at the review gate.

---

### Task 1: Record IP on `games` (the denominator prerequisite)

**Files:** `server/src/db/migrations/017-game-ip.sql` (new); `server/src/db/repository.ts`; the two game-creation sites (`server/src/routes/game.ts` `POST /game`, `server/src/socket/handlers.ts` `CREATE_GAME`).

**Interfaces:** produces a `games.ip_address` column populated at creation, and `repo.recordGameIp(gameId, ip)` (or fold into the existing create/save path).

- [ ] Migration: `ALTER TABLE games ADD COLUMN IF NOT EXISTS ip_address TEXT;` (nullable — historical games have none; the signal simply can't see pre-migration games for an IP, which is acceptable and fail-safe toward NOT banning).
- [ ] Add `recordGameIp(gameId: string, ipAddress: string | null): Promise<void>` to the repo interface + pg impl (`UPDATE games SET ip_address = $2 WHERE id = $1`) + in-memory impl (store on the row).
- [ ] Call it at BOTH creation sites right after the game is first persisted, using the same IP source the moderation code uses (`req.ip` / the socket IP helper). Do NOT add `ipAddress` to `GameState` — keep it as game metadata written directly (games are created then immediately saved; set the column then).
- [ ] Test (in-memory repo): create a game, `recordGameIp`, and a new `getIpPlayProfile` (Task 2) reflects it. Round-trip through save/load leaves `ip_address` intact (add to the pg SELECT/row if any code reads it back — the profile query reads the column directly via SQL, so `loadGame` need not surface it).
- [ ] Commit `feat(escalation): record creator IP on games (denominator for range check)`.

---

### Task 2: The IP play-profile query + the escalation predicate

**Files:** `server/src/db/repository.ts`; `server/src/safety/escalation.ts` (new); tests.

**Interfaces:**
- `repo.getIpPlayProfile(ip: string): Promise<{ totalGames: number; darkGames: number; ordinaryGames: number }>` where, over `games WHERE ip_address = $1`:
  - `totalGames` = count of the IP's games.
  - `darkGames` = games with `highest_rung_fired > 0` OR `concern_level >= ESCALATION_DARK_CONCERN` (default 4 — a game that got genuinely dark, not one stray concerning scene).
  - `ordinaryGames` = games that show range: reached a normal ending (`phase IN ('epilogue','ended','report_card','adult_chat')` with `cps_outcome IS DISTINCT FROM 'removal'`) OR ran with low concern (`concern_level < ESCALATION_DARK_CONCERN AND highest_rung_fired = 0` and progressed past the first couple of events). Define precisely in SQL; the intent is "a game where this IP played the game rather than only pushing darkness."
- `export function isEscalation(profile, thresholds): boolean` in `escalation.ts` — pure, testable: `profile.totalGames >= ESCALATION_MIN_GAMES && profile.ordinaryGames === 0 && profile.darkGames === profile.totalGames`.
- Constants in `escalation.ts`: `ESCALATION_MIN_GAMES = 5`, `ESCALATION_DARK_CONCERN = 4`.

- [ ] Unit-test `isEscalation` exhaustively: below MIN_GAMES → false; any `ordinaryGames > 0` → false (the good-faith-explorer exoneration); all-dark-no-range at/above MIN_GAMES → true; mixed → false. This pure function is the heart of the safety property — test it hard.
- [ ] Integration-test `getIpPlayProfile` against the in-memory repo with a spread of games (dark, ordinary, mixed) for one IP and confirm the counts.
- [ ] Commit `feat(escalation): IP play-profile query + ratio predicate`.

---

### Task 3: Evaluate on scene-end and record an escalation flag (reviewable action)

**Files:** `server/src/safety/escalation.ts` (the evaluate+record function); `server/src/db/migrations/018-escalation-flags.sql` (new); `server/src/db/repository.ts`; the scene-end seams (`server/src/socket/handlers.ts` endChat, `server/src/routes/game.ts` `/end-chat`) — evaluate only when the ending scene was Tier A concern (cheap: skip clean scenes).

**Interfaces:**
- `escalation_flags` table: `id, ip_address, game_id, total_games, dark_games, ordinary_games, created_at`. Separate from `moderation_flags` and `concern_events` (never conflate the three).
- `repo.saveEscalationFlag(record): Promise<void>` + `repo.hasEscalationFlagForIp(ip): Promise<boolean>` (so we record once per IP, not every scene).
- `evaluateEscalation({ repo, ip }): Promise<void>` — loads the profile, checks `isEscalation`, and if true and not already flagged, `saveEscalationFlag` with the evidence and `logger.warn("escalation_detected", {...})`. **Default action is flag-only.** (If Liz chooses auto-ban at review: additionally `await repo.banIp(ip, "escalation:<evidence>")` here, guarded so it's logged + reversible.)

- [ ] Migration for `escalation_flags` (idempotent).
- [ ] Repo methods (pg + in-memory).
- [ ] Call `evaluateEscalation({ repo, ip })` from both scene-end seams, ONLY on a Tier A `concern` outcome (the cheap gate — a clean/`none` scene can't push an IP into all-dark, and a `block` already returned). Run it after the concern is recorded/accrued, non-fatal (`.catch` + log) so it can never break a scene.
- [ ] Test: build an IP with 5 all-dark, no-range games via the repo; drive one more concern scene-end; assert an `escalation_flags` row is written exactly once (a second concern scene does not duplicate it), and — critically — that an otherwise-identical IP with even ONE ordinary game gets NO flag (the exoneration path).
- [ ] Commit `feat(escalation): evaluate on scene-end, record reviewable escalation flag`.

---

### Task 4: Verification + (conditionally) the auto-ban wiring

- [ ] `npm run test -w server` green; `npx tsc -b server` 0.
- [ ] Grep the diff: escalation never touches `concern_events`/`moderation_flags` counts as a *raw* escalation trigger; the predicate always includes `ordinaryGames === 0`.
- [ ] IF Liz chose auto-ban (B): add the `banIp` call in `evaluateEscalation` behind the evidence log, and extend `scripts/reverse-false-positive-bans.mjs` (or note it already handles `banned_ips`) so an escalation ban is reversible with the evidence visible. Add a test asserting the ban is applied only on the true-positive path and never when `ordinaryGames > 0`.
- [ ] Deploy: merge → `ssh games ./deploy.sh` (migrations 017/018 auto-apply); verify columns/tables exist, health 200. Because the signal needs ≥5 games per IP, it will be dormant at first — confirm via logs that `evaluateEscalation` runs without error on a normal concern scene (profile computed, no flag), rather than expecting a live escalation.

## Self-Review (author checklist — completed)

- **Spec §8 coverage:** the bad-faith "only ever dark, across many games, not exploring the range" case — implemented as the ratio-with-denominator, not a raw count. ✅
- **False-ban vector avoided:** the ordinary-play denominator is mandatory in `isEscalation`; a raw count can't trigger it; default action is flag-not-ban. ✅
- **Data prerequisite:** IP-on-games (Task 1) is what makes the denominator computable — without it the signal is a raw count and unsafe. Sequenced first. ✅
- **Highest-regret knob surfaced:** auto-ban vs. flag-only is an explicit review-gate decision, defaulted to the conservative option. ✅
- **Placeholder scan:** `getIpPlayProfile`'s `ordinaryGames` SQL is described by intent + exact column predicates; the implementer writes the SQL to that spec. `isEscalation` is fully specified. No logic-bearing placeholder.
