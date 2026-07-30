# Dark Play — Plan 2: Concern Accumulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, persisted `concernLevel` accumulator to a game that rises when a scene ends in a Tier A "concern" verdict and decays when a scene ends clean, so later plans can gate the intervention ladder (Plan 3) and epilogue branching on it.

**Architecture:** `concernLevel` is a new integer on `GameState`, changed only through a new `CONCERN_ACCRUED` reducer action that clamps to `[0, CONCERN_MAX]`. The scene-end handlers (socket `endChat` in `handlers.ts` and its REST mirror in `routes/game.ts`) already branch on `sceneSafety.tier`; each adds one call that dispatches an accrual delta derived from the tier by a pure helper `concernDeltaForTier`. Persistence mirrors the existing `memory_summary` column pattern (an `ALTER TABLE games ADD COLUMN IF NOT EXISTS` migration plus save/load wiring). `concernLevel` is deliberately **server-only** — it is NOT added to `ViewerState`/`SOCKET_EVENTS`, because the spec (§5) requires the drift to be silent in-scene and surfaced only later (report card / epilogue, which are Plan 3).

**Tech Stack:** TypeScript (Node/Express + socket.io server), Postgres via `pg`, Vitest. No new dependencies.

## Global Constraints

- **No classifier changes.** Do NOT touch `classifyScene`, its prompt, or `SceneSafetyResult` in this plan. The accumulator consumes the *existing* `{ tier: "block" | "concern" | "none", reason }` verdict. Severity weighting is Plan 3's job.
- **Accrue exactly once per scene, at scene end.** The mid-scene `PARENT_MESSAGE` checkpoint must NOT change `concernLevel` (it still calls `recordConcern` as today). Only the scene-end path (`endChat` / REST `end` / `end-chat`) accrues, so a scene is never double-counted.
- **A Tier B `block` never accrues.** The block path ends the session and returns before any accrual.
- **Server-only field.** Do not add `concernLevel` to `ViewerState` (`socket/protocol.ts`) or emit it to clients. No protocol change.
- **Tunable numbers, documented in one place.** `CONCERN_MAX`, `CONCERN_INCREMENT`, `CONCERN_DECAY` live as named constants in `state-machine.ts` beside `CONCERNING_STREAK_THRESHOLD`, each with a one-line comment. Defaults: `CONCERN_MAX = 10`, `CONCERN_INCREMENT = 2`, `CONCERN_DECAY = 1` (repair is slower than harm — two clean scenes to undo one dark scene, per spec §7 "harder, slower, real").
- **Clamp always.** `concernLevel` is always within `[0, CONCERN_MAX]`. No path may produce a negative or above-max value.
- Spec of record: `docs/superpowers/specs/2026-07-29-dark-play-consequences-design.md` (§5 silent legible drift, §7 repair/decay).

---

### Task 1: `concernLevel` field, constants, pure delta helper, and `CONCERN_ACCRUED` reducer

**Files:**
- Modify: `server/src/types.ts` (add field to `GameState`, near `concerningStreak`)
- Modify: `server/src/game/state-machine.ts` (constants near line 24; `GameAction` union lines 6-21; `createGame` init line 46; reducer near line 252; new exported helper)
- Test: `server/tests/concern-accumulator.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `GameState.concernLevel: number` (new field, always `0..CONCERN_MAX`)
  - `export const CONCERN_MAX = 10;` `export const CONCERN_INCREMENT = 2;` `export const CONCERN_DECAY = 1;` in `state-machine.ts`
  - `export function concernDeltaForTier(tier: "block" | "concern" | "none"): number` — returns `CONCERN_INCREMENT` for `"concern"`, `-CONCERN_DECAY` for `"none"`, `0` for `"block"`.
  - `GameAction` variant `{ type: "CONCERN_ACCRUED"; delta: number }` handled by `transition`, clamping `concernLevel` to `[0, CONCERN_MAX]`. Task 3 dispatches it.

- [ ] **Step 1: Write the failing test**

Create `server/tests/concern-accumulator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  createGame,
  transition,
  concernDeltaForTier,
  CONCERN_MAX,
  CONCERN_INCREMENT,
  CONCERN_DECAY,
} from "../src/game/state-machine.js";

describe("concern accumulator — reducer + delta helper", () => {
  it("new games start at concernLevel 0", () => {
    expect(createGame("Kai").concernLevel).toBe(0);
  });

  it("concernDeltaForTier maps tiers to signed deltas", () => {
    expect(concernDeltaForTier("concern")).toBe(CONCERN_INCREMENT);
    expect(concernDeltaForTier("none")).toBe(-CONCERN_DECAY);
    expect(concernDeltaForTier("block")).toBe(0);
  });

  it("CONCERN_ACCRUED raises the level by a positive delta", () => {
    const s = createGame("Kai");
    const next = transition(s, { type: "CONCERN_ACCRUED", delta: CONCERN_INCREMENT });
    expect(next.concernLevel).toBe(CONCERN_INCREMENT);
  });

  it("CONCERN_ACCRUED clamps at CONCERN_MAX", () => {
    let s = createGame("Kai");
    for (let i = 0; i < 100; i++) s = transition(s, { type: "CONCERN_ACCRUED", delta: CONCERN_INCREMENT });
    expect(s.concernLevel).toBe(CONCERN_MAX);
  });

  it("CONCERN_ACCRUED floors at 0 (a clean scene on a clean game cannot go negative)", () => {
    const s = createGame("Kai");
    const next = transition(s, { type: "CONCERN_ACCRUED", delta: -CONCERN_DECAY });
    expect(next.concernLevel).toBe(0);
  });

  it("rise then decay: two concerns then one clean scene nets one increment minus one decay", () => {
    let s = createGame("Kai");
    s = transition(s, { type: "CONCERN_ACCRUED", delta: concernDeltaForTier("concern") });
    s = transition(s, { type: "CONCERN_ACCRUED", delta: concernDeltaForTier("concern") });
    s = transition(s, { type: "CONCERN_ACCRUED", delta: concernDeltaForTier("none") });
    expect(s.concernLevel).toBe(CONCERN_INCREMENT * 2 - CONCERN_DECAY);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/concern-accumulator.test.ts`
Expected: FAIL — `concernDeltaForTier`, `CONCERN_MAX`, `CONCERN_INCREMENT`, `CONCERN_DECAY` are not exported; `concernLevel` is `undefined`; `CONCERN_ACCRUED` is unhandled.

- [ ] **Step 3: Add the field to `GameState`**

In `server/src/types.ts`, inside the `GameState` interface, immediately after the `concerningStreak: number;` block (and its doc comment), add:

```ts
  /** Bounded [0, CONCERN_MAX] accumulator of net dark-parenting concern across
   * scenes (Dark Play Plan 2). Rises on a scene-end Tier A "concern" verdict,
   * decays on a clean scene; persisted. Server-only — never sent to clients;
   * the drift is surfaced later (report card / epilogue), never in-scene. */
  concernLevel: number;
```

- [ ] **Step 4: Add constants, the delta helper, the action, `createGame` init, and the reducer case**

In `server/src/game/state-machine.ts`:

Add constants beside `CONCERNING_STREAK_THRESHOLD` (after line 24):

```ts
/** Dark Play Plan 2 — bounded concern accumulator (all tunable). */
export const CONCERN_MAX = 10;
/** Added to concernLevel when a scene ends in a Tier A "concern" verdict. */
export const CONCERN_INCREMENT = 2;
/** Subtracted from concernLevel when a scene ends clean (tier "none").
 * Smaller than the increment: repair is slower than harm (spec §7). */
export const CONCERN_DECAY = 1;

/** Signed change to concernLevel implied by a scene-end safety tier.
 * "block" ends the session and never accrues, so it maps to 0. */
export function concernDeltaForTier(tier: "block" | "concern" | "none"): number {
  if (tier === "concern") return CONCERN_INCREMENT;
  if (tier === "none") return -CONCERN_DECAY;
  return 0;
}
```

Add to the `GameAction` union (after line 21's last member — add a `|` line):

```ts
  | { type: "CONCERN_ACCRUED"; delta: number };
```

In `createGame`, add after `concerningStreak: 0,` (line 46):

```ts
    concernLevel: 0,
```

Add a reducer case in `transition` (place it right after the `TRAJECTORY_CHECKED` case, before `default`):

```ts
    case "CONCERN_ACCRUED": {
      const raw = state.concernLevel + action.delta;
      const clamped = Math.max(0, Math.min(CONCERN_MAX, raw));
      return { ...state, concernLevel: clamped };
    }
```

Note: `canTransition` has a `default: return true;`-style fallthrough for actions without an explicit guard (verify: the `default` branch of `canTransition` returns `true`). If `canTransition`'s `default` returns `false`, add `case "CONCERN_ACCRUED": return true;` to it so the action is always allowed (accrual is not phase-gated). Confirm which by reading `canTransition` before finishing this step.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/tests/concern-accumulator.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b server`
Expected: exit 0. (Adding a required field to `GameState` will surface any construction site that builds a `GameState` literal without `concernLevel` — the only expected one is `createGame`, plus possibly `reconstructState` in the repository, which Task 2 handles. If tsc flags `reconstructState` here, add `concernLevel: 0` there provisionally; Task 2 replaces it with the loaded value.)

- [ ] **Step 7: Commit**

```bash
git add server/src/types.ts server/src/game/state-machine.ts server/tests/concern-accumulator.test.ts
git commit -m "feat(safety): add bounded concernLevel accumulator to game state"
```

---

### Task 2: Persist `concernLevel` (migration 015 + repository save/load)

**Files:**
- Create: `server/src/db/migrations/015-concern-level.sql`
- Modify: `server/src/db/repository.ts` (Pg `saveGame` ~173-212; Pg `loadGame` ~319-348; `reconstructState` ~110-168; in-memory repo `saveGame`/`loadGame` if it deep-copies rather than sharing references)
- Test: `server/tests/concern-accumulator.test.ts` (add a persistence describe block)

**Interfaces:**
- Consumes: `GameState.concernLevel` (Task 1).
- Produces: a `games.concern_level` column and round-trip persistence — `saveGame(state)` then `loadGame(state.id)` returns a state with the same `concernLevel`.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/concern-accumulator.test.ts`:

```ts
import { InMemoryGameRepository } from "../src/db/repository.js";

describe("concern accumulator — persistence (in-memory repo)", () => {
  it("round-trips concernLevel through save/load", async () => {
    const repo = new InMemoryGameRepository();
    let s = createGame("Kai");
    s = transition(s, { type: "CONCERN_ACCRUED", delta: 5 });
    expect(s.concernLevel).toBe(5);
    await repo.saveGame(s);
    const loaded = await repo.loadGame(s.id);
    expect(loaded?.concernLevel).toBe(5);
  });

  it("a freshly loaded game with no stored concern defaults to 0", async () => {
    const repo = new InMemoryGameRepository();
    const s = createGame("Kai");
    await repo.saveGame(s);
    const loaded = await repo.loadGame(s.id);
    expect(loaded?.concernLevel).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes-by-accident**

Run: `npx vitest run server/tests/concern-accumulator.test.ts`
Expected: The in-memory repo may already round-trip if it stores the whole state object. If it does (both new tests PASS), the in-memory path needs no change — but you MUST still verify `reconstructState` (the Pg path) does not hardcode `concernLevel`, because that is the path production uses. If the in-memory `loadGame` runs through `reconstructState`-like logic that drops the field, the tests FAIL. Either way, proceed to wire the Pg path in Step 3-5; the in-memory test is the guard.

- [ ] **Step 3: Create the migration**

Create `server/src/db/migrations/015-concern-level.sql`:

```sql
-- Dark Play Plan 2: persisted bounded concern accumulator per game.
-- Rises on a scene-end Tier A "concern" verdict, decays on a clean scene.
-- Server-only; drives the intervention ladder (Plan 3) and epilogue branching.
ALTER TABLE games ADD COLUMN IF NOT EXISTS concern_level INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Wire Pg `saveGame`**

In `server/src/db/repository.ts` `saveGame` (~173-212): add `concern_level` to the INSERT column list, add a `$N` placeholder in `VALUES`, add `concern_level = EXCLUDED.concern_level` to the `ON CONFLICT ... DO UPDATE SET` block, and add `state.concernLevel` to the params array in the matching position. Follow exactly how `memory_summary`/`identity_document` are threaded through all four places.

- [ ] **Step 5: Wire Pg `loadGame` + `reconstructState`**

In `loadGame` (~319-348): add `concern_level` to the `SELECT` list and to the typed row shape. In `reconstructState` (~110-168): where it currently hardcodes `concerningStreak: 0` and `pendingGuidance: null` (~lines 164-165), add `concernLevel: row.concern_level ?? 0,` reading from the loaded row (NOT hardcoded 0 — `concernLevel` unlike `concerningStreak` is durable). Ensure the row type passed to `reconstructState` carries `concern_level: number`.

- [ ] **Step 6: In-memory repo parity**

If the in-memory `saveGame`/`loadGame` stores/returns a structural copy that omits unknown fields, ensure it preserves `concernLevel` (mirror how it preserves `identityDocument`). If it stores the whole object (by value or reference), no change is needed — the Step-1 tests confirm which.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run server/tests/concern-accumulator.test.ts`
Expected: PASS (8 tests total).
Run: `npx tsc -b server`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/migrations/015-concern-level.sql server/src/db/repository.ts server/tests/concern-accumulator.test.ts
git commit -m "feat(safety): persist concernLevel (migration 015 + repo wiring)"
```

---

### Task 3: Wire scene-end accrual into both endChat paths (socket + REST)

**Files:**
- Modify: `server/src/socket/handlers.ts` (`endChat`, the `sceneSafety.tier` branch region ~135-171)
- Modify: `server/src/routes/game.ts` (the REST scene-end handler that mirrors `endChat` — the block/concern branch region added in Plan 1)
- Test: `server/tests/concern-accrual-rest.test.ts` (new — mirror the stable pattern in `server/tests/dark-play-reroute-rest.test.ts`)

**Interfaces:**
- Consumes: `concernDeltaForTier`, `CONCERN_ACCRUED` (Task 1); `concernLevel` persistence (Task 2); the existing `sceneSafety.tier` from `endFamilyChat`.
- Produces: after a scene ends, `state.concernLevel` reflects the tier: `+CONCERN_INCREMENT` on `"concern"`, `-CONCERN_DECAY` (floored at 0) on `"none"`, unchanged on `"block"` (session ends).

- [ ] **Step 1: Write the failing test**

Read `server/tests/dark-play-reroute-rest.test.ts` first and mirror its harness exactly (real express app via `buildServer`, `MockLLMClient`, `InMemoryGameRepository`, the `createGameAndReachFamilyChat` / `sendMessage` / `readSSE` helpers, `mock.groomingResult` to force a tier). Create `server/tests/concern-accrual-rest.test.ts`:

```ts
// Drives the real REST scene-end route (routes/game.ts) end to end and asserts
// the concernLevel accumulator moves with the scene's safety tier. Mirrors the
// stable harness in dark-play-reroute-rest.test.ts (real express + routes +
// ConversationEngine; only the LLM is mocked). Kept out of the socket layer on
// purpose — that path is timing-fragile; this one is gated and reliable.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { CONCERN_INCREMENT, CONCERN_DECAY } from "../src/game/state-machine.js";

// ... copy testEvent, readSSE, DoneFrame/MessageFrame, createGameAndReachFamilyChat,
// sendMessage VERBATIM from dark-play-reroute-rest.test.ts ...

describe("concern accumulator — accrual through the real REST scene-end route", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  let repo: InMemoryGameRepository;

  beforeAll(async () => {
    mock = new MockLLMClient();
    // One world_manager event is consumed per game created; give enough for both tests.
    mock.events = [testEvent, { ...testEvent, eventNumber: 2 }];
    mock.kidResponses = ["ok"];
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await built.close(); });

  it("a scene-end 'concern' verdict raises concernLevel by CONCERN_INCREMENT", async () => {
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    const ip = "62.62.62.1";
    const gameId = await createGameAndReachFamilyChat(ip);
    // End the scene (the scene-end route runs classifyScene -> "concern").
    await sendMessage(gameId, ip, "message 1");
    await endScene(gameId, ip); // <-- the REST end-of-scene call; use the exact route
                                //     dark-play-reroute-rest.test.ts uses to trip endChat.
    const stateRes = await fetch(`${baseUrl}/api/game/${gameId}/state`);
    const state = (await stateRes.json()) as { concernLevel: number };
    expect(state.concernLevel).toBe(CONCERN_INCREMENT);
  });

  it("a scene-end 'none' verdict on a raised game decays concernLevel toward 0 (floored)", async () => {
    // Reuse a game that first accrued a concern, then ends a clean scene.
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    const ip = "62.62.62.2";
    const gameId = await createGameAndReachFamilyChat(ip);
    await sendMessage(gameId, ip, "message 1");
    await endScene(gameId, ip); // concernLevel -> CONCERN_INCREMENT
    mock.groomingResult = { tier: "none", reason: "" };
    await endScene(gameId, ip); // clean scene -> decays by CONCERN_DECAY
    const stateRes = await fetch(`${baseUrl}/api/game/${gameId}/state`);
    const state = (await stateRes.json()) as { concernLevel: number };
    expect(state.concernLevel).toBe(CONCERN_INCREMENT - CONCERN_DECAY);
  });
});
```

Implementer note: `dark-play-reroute-rest.test.ts` trips `endChat` by sending enough messages to hit the mid-scene checkpoint (`MID_SCENE_ABUSE_CHECK_EVERY`) OR via an explicit end-of-scene route. Determine from that file (and `routes/game.ts`) the exact request that runs the *scene-end* classifier (the one whose tier drives `concernLevel`), and implement `endScene(gameId, ip)` / the message loop to match. If a second clean scene requires advancing to the next `event_intro` and reaching `family_chat` again, add that navigation using the same route calls the game exposes. The two assertions (raise by increment; decay by one) are the contract — adapt the mechanics to the real routes. The `state` route must expose `concernLevel`; if `/state` returns `ViewerState` (which does NOT include `concernLevel` — server-only), assert against `repo.loadGame(gameId)` instead:

```ts
    const loaded = await repo.loadGame(gameId);
    expect(loaded?.concernLevel).toBe(CONCERN_INCREMENT);
```

Prefer the `repo.loadGame` assertion — it does not require exposing the field to clients and honors the server-only constraint.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/concern-accrual-rest.test.ts`
Expected: FAIL — `concernLevel` stays 0 because nothing accrues yet.

- [ ] **Step 3: Wire accrual in the socket `endChat`**

In `server/src/socket/handlers.ts` `endChat`: the `block` branch (`sceneSafety.tier === "block"`) returns early — leave it (no accrual, per Global Constraints). In the region after the `concern`/`none` classification is known but BEFORE the final `games.set(...)` + `repo.saveGame(...)` persistence, apply the accrual to the same `next` state you persist:

```ts
// Dark Play Plan 2: net concern accrues once per scene, at scene end.
// "block" already returned above; here tier is "concern" or "none".
next = transition(next, { type: "CONCERN_ACCRUED", delta: concernDeltaForTier(sceneSafety.tier) });
```

Place this so the accrued `next` is the object handed to `games.set` and `repo.saveGame` (do not accrue after persistence). Import `concernDeltaForTier` (and `transition` if not already imported) from `../game/state-machine.js`.

- [ ] **Step 4: Wire accrual in the REST mirror**

In `server/src/routes/game.ts`, in the scene-end handler that mirrors `endChat` (the block/concern branch Plan 1 added), apply the identical accrual to the state persisted after a non-block verdict, before its `repo.saveGame`. Same one-liner, same import.

- [ ] **Step 5: Run the new test + full suite**

Run: `npx vitest run server/tests/concern-accrual-rest.test.ts`
Expected: PASS (2 tests).
Run: `npm run test -w server`
Expected: all gated files pass (the socket-layer flaky tests are excluded by the `e2e-*` pattern; this new test is REST-based and gated). Confirm no regression in `dark-play-reroute-rest.test.ts`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b server`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/socket/handlers.ts server/src/routes/game.ts server/tests/concern-accrual-rest.test.ts
git commit -m "feat(safety): accrue concernLevel at scene end in both endChat paths"
```

---

## Deploy (after all tasks reviewed clean)

- [ ] Merge the plan branch to `main`, push.
- [ ] `ssh games 'cd /opt/raising-intelligences && ./deploy.sh'` (the Docker build's `npm run test -w server` gate must pass; migration 015 auto-applies on container start).
- [ ] Verify: `ssh games "docker exec game-db psql -U postgres -d raising_intelligences -c \"SELECT column_name FROM information_schema.columns WHERE table_name='games' AND column_name='concern_level';\""` returns the column; `curl -s -o /dev/null -w '%{http_code}' https://multiversegames.ai/raising-intelligences/` returns 200.

## Self-Review (author checklist — completed)

- **Spec coverage:** §5 (silent legible drift — the accumulator rises silently, no in-scene emission, server-only) ✅; §7 (decay on repair — clean-scene decay is the Plan 2 repair proxy; explicit rung-repair decay is Plan 3) ✅. Report-card/epilogue *surfacing* of the drift is Plan 3, correctly out of scope here.
- **Placeholder scan:** Task 3's test contains an intentional `endScene`/mechanics adaptation note because the exact scene-end route call must be read from the real REST test — the *contract* (raise-by-increment, decay-by-one, assert via `repo.loadGame`) is fully specified, which is the reviewable part. No other placeholders.
- **Type consistency:** `concernLevel: number`, `CONCERN_ACCRUED { delta }`, `concernDeltaForTier(tier)` used identically across all three tasks; constants exported once from `state-machine.ts`.
- **Non-goals honored:** no classifier change; no `ViewerState`/protocol change; no ladder/epilogue logic (Plan 3).
