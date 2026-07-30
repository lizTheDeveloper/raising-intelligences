# Plan 1 (classifier reroute) — Test-coverage fix report

**Branch:** `feat/dark-play-plan1`
**Scope:** Close the routing-layer test gap flagged by code review — the
tier -> side-effect dispatch (`block` -> `applyModerationBlock`, `concern` ->
`recordConcern` + continue, `none` -> nothing) had no test that drove the
actual routing code; a miswire (e.g. "concern" calling the ban path) would
have passed the whole suite. Tests only, plus one stale comment. No
production logic changed.

## Status: DONE

## Commit

`3ab5b2b` — `test(safety): cover the tier→routing layer (concern continues, block terminates)`

(Run `git log -1 --stat 3ab5b2b` in the worktree for the full diff stat.)

## What changed

### Task A — `server/tests/conversation-engine.test.ts`
The test "a 'concern' verdict records a concern event but does NOT end the
session" only asserted `sceneSafety.tier`, never the session-alive claim in
its own name. Now captures `nextState` from `engine.endFamilyChat(...)` and
asserts `nextState.phase` is `"debrief"` (not `"ended"`). The engine layer
has no repo/IP-ban access, so `recordConcern`'s persistence is intentionally
left to the routing-layer tests (Task B) — the comment says so.

### Task B — routing-layer tests (new tests, not new files' worth of scope creep — see below)
Two routing layers independently implement the same tier dispatch:
`server/src/socket/handlers.ts` (multiplayer, socket.io) and
`server/src/routes/game.ts` (solo REST/SSE). The Plan 1 implementation
report (`.superpowers/sdd/plan1-report.md`, deviation #1) explicitly flagged
`routes/game.ts` as a second, independent copy of the dispatch that the
original plan's file list missed — so a miswire could live in either one,
and testing only one would leave the other's failure mode invisible. I
covered both:

- **`server/tests/dark-play-reroute.test.ts`** (extended) — added a new
  `describe("dark-play reroute (routing layer, via real socket handlers)")`
  block. Boots a real `http.Server` + `socket.io` `Server`, calls the actual
  `registerSocketHandlers(...)` (not `recordConcern`/`applyModerationBlock`
  directly), connects two real `socket.io-client` sockets, plays through
  create → join → ready ×2 → family_chat, then sends 4 `PARENT_MESSAGE`
  events (the mid-scene checkpoint fires on the 4th) with a `MockLLMClient`
  whose `groomingResult` is `{ tier: "concern" | "block", reason }`.
  - **concern case** asserts: IP not banned (`repo.isIpBanned`), `phase` is
    not `"ended"`, a `concern_events` row exists (`repo.loadConcernEvents`),
    and the kid's reply is present in the broadcast `STATE` (i.e. the turn
    was actually delivered, not swallowed).
  - **block case** asserts: IP is banned, `phase` is `"ended"`, and (bonus)
    no `concern_events` row was created.
  - The pre-existing two tests in this file (which call `recordConcern` /
    `applyModerationBlock` directly) were left in place — they still verify
    those functions work in isolation; a comment now explains why they're
    *not* sufficient on their own.

- **`server/tests/dark-play-reroute-rest.test.ts`** (new file) — same shape,
  for the REST/SSE path. Boots the real `express` app via `buildServer()`
  with a `MockLLMClient` (no cassette, so the classifier's tier is fully
  controllable), drives `POST /api/game` → `POST /api/game/:id/next-event` →
  4× `POST /api/game/:id/message`, and reads the real SSE frames back
  (`chunk`/`done`/`terminated`). Same four assertions per tier, plus reading
  `GET /api/game/:id/state` to confirm `phase`.
  - I added this beyond the letter of "socket OR REST" because the plan
    report itself calls out `routes/game.ts` as an independent copy of the
    dispatch that the original plan missed — the same class of miswire the
    code review is worried about could live there and go uncaught by a
    socket-only test. Flagging this expansion explicitly per instructions:
    this is a 4th touched test file beyond the literal three named in the
    task (conversation-engine.test.ts, dark-play-reroute.test.ts, admin.ts).

Both new test suites genuinely drive the routing layer — they call
`registerSocketHandlers`/`buildServer` and the real client/server transport,
never `recordConcern`/`applyModerationBlock` directly. A miswire in either
`handlers.ts` or `routes/game.ts` (e.g. "concern" routed to
`applyModerationBlock`) would fail these tests.

### Task C — `server/src/routes/admin.ts:62-68`
Corrected the stale comment above `/admin/moderation-flags`. It used to say
the queue lists "both the per-message and scene-level checks" from
`moderation_flags`. Since the Plan 1 reroute, `moderation_flags` only holds
per-message checks and scene-level **`block`** verdicts; scene-level
**`concern`** verdicts never land there — they go to the separate
`concern_events` table (never a ban, session continues) and are outside this
review queue. Comment-only change, no code touched.

## Verification

```
npx tsc -b server                        # exit 0
npm run test -w server                   # 24 -> 25 test files, 201 -> 205 tests, all passing
npm run test -w server -- dark-play-reroute        # 4/4 pass (2 regression + 2 socket-routing)
npm run test -w server -- dark-play-reroute-rest   # 2/2 pass (REST-routing)
npm run test -w server -- conversation-engine      # 11/11 pass
```

Ran the full suite 10 consecutive times after the final change (`for i in
1..10; npm run test -w server`) — **10/10 green, 205/205 tests every time.**

## Known pre-existing flake (not introduced by this change) — IMPORTANT caveat

While iterating I saw `npm run test -w server` fail intermittently with:

```
FAIL tests/socket.test.ts > socket multiplayer flow > runs create → join → ready → message across two clients
AssertionError: expected [] to have a length of 2 but got +0
 ❯ tests/socket.test.ts:105:31
```

I did not touch `socket.test.ts`. Before assuming this was caused by the new
test files adding socket load, I measured the **stashed baseline** (my diff
removed entirely, i.e. the branch exactly as it was before this session)
across 45 total full-suite runs: **1/45 failures (≈2%)**, same assertion, same
file. With my changes applied, across ~48 total full-suite runs (in batches
of 3, 5, 10, 25): **2/48 failures (≈4%)**, same assertion. Both rates are
low and in the same ballpark — this is a pre-existing, load/timing-dependent
race in `socket.test.ts` (a file outside this task's scope), not a
deterministic regression caused by these changes. It reproduced 0/15 times
when I ran only `socket.test.ts` + `dark-play-reroute.test.ts` together
(i.e. it needs the full 24-25-file parallel-fork load to surface, not just
these two files), consistent with CPU-contention-triggered timing rather
than a logic bug in the tests I added or changed.

I deliberately did **not** modify `socket.test.ts` — it's outside the three
files (plus the disclosed 4th) this task authorized, the code is not mine to
"fix" under a tests-only mandate without being asked, and the instructions
were explicit not to weaken/paper over anything to force green. The final
full-suite run before commit was clean (205/205); rerun `npm run test -w
server` a few times if you want to see the baseline flake rate for yourself
before deciding whether `socket.test.ts` needs its own follow-up ticket.

## Exact commands run (final, pre-commit)

```
npx tsc -b server                # exit 0
npm run test -w server           # 25 files, 205 tests, all passing (this run and 9 more in a row)
```
