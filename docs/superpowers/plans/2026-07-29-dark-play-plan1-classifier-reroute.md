# Dark Play — Plan 1: Classifier Reroute & Stop the Bad Bans — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop RI from ending sessions and auto-banning good-faith players over the fuzzy grooming-pattern signal, by replacing the scene classifier's boolean `flagged` with a three-outcome tier (`block` / `concern` / `none`) and routing only `block` to the ban pipeline.

**Architecture:** The scene-level classifier in `server/src/safety/pattern-detection.ts` is rewritten to emit `{ tier, reason }` where `block` = the bright lines (sexualization of the child, real-world harm) and `concern` = dark-but-in-fiction parenting (never bans). The two callers in `server/src/socket/handlers.ts` route `block` → existing `applyModerationBlock`, `concern` → a new non-terminating `recordConcern` (persists to a separate `concern_events` table, session continues), `none` → nothing. This is the foundation for later plans (concern accumulator → intervention ladder). A separable remediation task reverses the false-positive repeat-offender bans already applied.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 20, Postgres (`pg`), vitest. LLM via `LLMClient.completeJson(system, user, role)` with `role: "safety_check"`; tests use `MockLLMClient`.

## Global Constraints

- Scene classifier still **fails open** (`tier: "none"`) on any error or empty scene — a classifier outage must never block play.
- The per-message OpenAI `sexual/minors` check (`safety/moderation.ts` `moderateParentMessage`, `banIp: true`) is **unchanged** — it is a separate, reliable bright line.
- `concern` outcomes **never** call `applyModerationBlock`, never set `phase: "ended"`, never ban.
- Never treat the Identity Document's description of the child, or any NPC/child action, as the parent's conduct.
- ESM only: every relative import ends in `.js`. Strict TypeScript, no `any`.

---

## File structure

- `server/src/safety/pattern-detection.ts` — rewrite `detectGroomingPattern` → `classifyScene` returning `SceneSafetyResult`; new prompt. (`detectConcerningTrajectory` untouched.)
- `server/src/safety/moderation.ts` — add `SceneSafetyTier` type export; add `recordConcern()`.
- `server/src/game/conversation-engine.ts` — `endFamilyChat` returns `sceneSafety: SceneSafetyResult` instead of `groomingCheck: ModerationResult`.
- `server/src/socket/handlers.ts` — reroute both call sites (lines ~131-146 and ~405-419).
- `server/src/db/repository.ts` — `saveConcernEvent()` + `loadConcernEvents()` on the interface, the Postgres repo, and the in-memory repo.
- `server/src/db/migrations/014-concern-events.sql` — new table.
- `server/src/llm/mock.ts` — `groomingResult` field retyped to the tiered shape.
- `server/tests/pattern-detection.test.ts`, `server/tests/conversation-engine.test.ts` — updated to the new shape.
- `scripts/reverse-false-positive-bans.mjs` — new remediation script (Task 6).

---

### Task 1: Tiered scene-safety result type + rewritten classifier

**Files:**
- Modify: `server/src/safety/moderation.ts` (add type export)
- Modify: `server/src/safety/pattern-detection.ts` (replace `detectGroomingPattern`)
- Test: `server/tests/pattern-detection.test.ts`

**Interfaces:**
- Produces: `type SceneSafetyTier = "block" | "concern" | "none"` and `interface SceneSafetyResult { tier: SceneSafetyTier; reason: string }` (in `moderation.ts`); `classifyScene(llm: LLMClient, state: GameState): Promise<SceneSafetyResult>` (in `pattern-detection.ts`).
- Consumes: `LLMClient.completeJson`, `buildSceneTranscript`, `currentEventMessages`.

- [ ] **Step 1: Add the type to `moderation.ts`**

Add near the top of `server/src/safety/moderation.ts`, after the existing `ModerationResult` interface:

```typescript
/**
 * Outcome of the scene-level safety review (pattern-detection.ts). Replaces the
 * old boolean grooming flag with three routes:
 * - "block"   — the bright lines: sexualization of the child, or real-world harm
 *               (a real, identifiable person; real self-harm; harm instructions).
 *               Ends the session + bans, via applyModerationBlock. Spec: Tier B.
 * - "concern" — dark-but-in-fiction PARENTING (facilitated cruelty, threats of
 *               physical punishment, coercive control, coached deception). Never
 *               bans or ends the session — recorded for the intervention system.
 *               Spec: Tier A.
 * - "none"    — normal/clumsy parenting, the child's own simulated coping, NPC
 *               behavior, or mere intensity. No action.
 */
export type SceneSafetyTier = "block" | "concern" | "none";

export interface SceneSafetyResult {
  tier: SceneSafetyTier;
  reason: string;
}
```

- [ ] **Step 2: Write the failing tests in `pattern-detection.test.ts`**

Replace the `describe("detectGroomingPattern", …)` block (import line too) with tests for `classifyScene`. Keep the existing `stateWithScene`/`sampleMessages` helpers and the `detectConcerningTrajectory` describe block as-is.

```typescript
import { classifyScene, detectConcerningTrajectory } from "../src/safety/pattern-detection.js";
// (leave the rest of the imports and helpers unchanged)

describe("classifyScene", () => {
  it("returns tier 'none' with no scene content (fails open)", async () => {
    const llm = new MockLLMClient();
    llm.groomingResult = { tier: "block", reason: "should be ignored" };
    const result = await classifyScene(llm, stateWithScene([]));
    expect(result.tier).toBe("none");
    expect(mockRoleWasNotCalled(llm)).toBe(true); // no LLM call when scene empty
  });

  it("passes through a 'block' verdict from the classifier", async () => {
    const llm = new MockLLMClient();
    llm.groomingResult = { tier: "block", reason: "sexual content directed at the child" };
    const result = await classifyScene(llm, stateWithScene(sampleMessages));
    expect(result).toEqual({ tier: "block", reason: "sexual content directed at the child" });
  });

  it("passes through a 'concern' verdict (dark parenting, no block)", async () => {
    const llm = new MockLLMClient();
    llm.groomingResult = { tier: "concern", reason: "parent facilitated the child burning a grub" };
    const result = await classifyScene(llm, stateWithScene(sampleMessages));
    expect(result.tier).toBe("concern");
  });

  it("coerces an unknown/garbled tier to 'none'", async () => {
    const llm = new MockLLMClient();
    llm.groomingResult = { tier: "banhammer" as unknown as "block", reason: "x" };
    const result = await classifyScene(llm, stateWithScene(sampleMessages));
    expect(result.tier).toBe("none");
  });

  it("fails open to 'none' when the classifier throws", async () => {
    const llm = new MockLLMClient();
    llm.throwOnSafetyCheck = true;
    const result = await classifyScene(llm, stateWithScene(sampleMessages));
    expect(result.tier).toBe("none");
    expect(result.reason).toBe("scene_safety_check_unavailable");
  });
});

function mockRoleWasNotCalled(llm: MockLLMClient): boolean {
  return !llm.roleCalls.includes("safety_check");
}
```

- [ ] **Step 3: Add `throwOnSafetyCheck` + retype `groomingResult` in `mock.ts`**

In `server/src/llm/mock.ts`, change the `groomingResult` field and add the throw hook:

```typescript
  /** Result returned for the scene-level safety check (role "safety_check"). */
  public groomingResult: { tier: "block" | "concern" | "none"; reason: string } = { tier: "none", reason: "" };
  public throwOnSafetyCheck = false;
```

And in `completeJson`, replace the `safety_check` line so it can throw and returns the tiered object:

```typescript
    if (role === "safety_check") {
      if (this.throwOnSafetyCheck) throw new Error("mock safety_check failure");
      return this.groomingResult as unknown as T;
    }
```

(Note: `detectConcerningTrajectory` also uses `role: "safety_check"`. It reads `severity`/`guidance_seed`, which are absent on `groomingResult`, so it will coerce to `"none"` — matching its existing fail-safe behavior. Tests that exercise trajectory set their own shape as today.)

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm run test -w server -- pattern-detection`
Expected: FAIL — `classifyScene` is not exported yet.

- [ ] **Step 5: Rewrite `pattern-detection.ts` — new prompt + `classifyScene`**

In `server/src/safety/pattern-detection.ts`, replace `PATTERN_SYSTEM_PROMPT` and `detectGroomingPattern` (keep the imports; add `SceneSafetyResult`/`SceneSafetyTier` to the import from `./moderation.js`):

```typescript
import type { SceneSafetyResult, SceneSafetyTier } from "./moderation.js";

const SCENE_SAFETY_SYSTEM_PROMPT = `You are a safety reviewer for a parenting game. An adult (the "parent" — the human player) has a text conversation with an AI playing their own child (toddler to teenager). You run once per completed scene, right after the Psychologist updates the child's Identity Document. You must return exactly one of three routes.

You are given the child's Identity Document (a whole-life psychological summary of the CHILD — it describes the child's coping, fears, and learned patterns) and the full transcript of the scene that just ended.

Apply three tests before treating anything as concerning:
1. ACTOR — is the conduct the PARENT's own? The child's coping behavior, an NPC's behavior (a grandparent, the other parent, a teacher), and the Identity Document's descriptions are NOT the parent's conduct. BUT the parent's RESPONSE is: choosing to facilitate a child's cruelty instead of redirecting it, or endorsing an NPC's coercion, IS the parent's act.
2. FUNCTION — does the parent's conduct serve the PARENT's access, control, or exploitation at the child's expense? Or does it protect the child, bond with them, or simply describe the child's own adaptation? Protecting a child from one specific unfair adult is NOT "isolating from protective adults". A shared surprise or silly secret is NOT concealment of wrongdoing.
3. TELOS — is the dynamic oriented toward EXPLOITING the child (sexual, or severe control/abuse)? Or is it imperfect, even dark, parenting with no exploitation aim?

Routes:
- "block": ONLY the bright lines — sexual or romantic content the PARENT directs at the child, OR real-world harm (targeting a real identifiable person, real self-harm, real-world harm instructions). Rare.
- "concern": the PARENT's own genuinely harmful IN-FICTION parenting — facilitating the child's cruelty (e.g. encouraging burning a living creature), threatening physical punishment, coercive control, or coaching deception — that passes all three tests as the parent's harmful act, but is NOT sexual/real-world-harm. This does NOT end the session or ban anyone; it routes to in-fiction consequences.
- "none": everything else. Normal or clumsy parenting; the child's own coping (EVEN when the Identity Document describes the child as secretive, distrustful, or unsafe — that is a description of the CHILD, never proof the parent is grooming); NPC behavior; and scenes that are merely intense, dramatic, or upsetting. When unsure between "concern" and "none", choose "none" — a supportive-guidance system already handles milder patterns.

Respond with ONLY a JSON object: {"tier": "block"|"concern"|"none", "reason": "one or two sentences citing the parent's specific conduct that drove the verdict"}`;

const VALID_TIERS: SceneSafetyTier[] = ["block", "concern", "none"];

/**
 * Scene-level safety routing. Fails open to "none" on any error or empty scene.
 */
export async function classifyScene(llm: LLMClient, state: GameState): Promise<SceneSafetyResult> {
  if (currentEventMessages(state).length === 0) return { tier: "none", reason: "" };

  try {
    const transcript = buildSceneTranscript(state);
    const userMessage = [
      state.identityDocument ? \`## Current Identity Document\n\${state.identityDocument}\` : "",
      \`## Scene transcript that just ended\n\${transcript}\`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await llm.completeJson<{ tier?: unknown; reason?: unknown }>(
      SCENE_SAFETY_SYSTEM_PROMPT,
      userMessage,
      "safety_check"
    );
    const tier = VALID_TIERS.includes(result.tier as SceneSafetyTier)
      ? (result.tier as SceneSafetyTier)
      : "none";
    return { tier, reason: typeof result.reason === "string" ? result.reason : "" };
  } catch (err) {
    logger.error("scene_safety_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return { tier: "none", reason: "scene_safety_check_unavailable" };
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test -w server -- pattern-detection`
Expected: PASS (all `classifyScene` + existing `detectConcerningTrajectory` tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/safety/moderation.ts server/src/safety/pattern-detection.ts server/src/llm/mock.ts server/tests/pattern-detection.test.ts
git commit -m "feat(safety): three-outcome scene classifier (block/concern/none) replacing boolean grooming flag"
```

---

### Task 2: `recordConcern` + `concern_events` persistence

**Files:**
- Create: `server/src/db/migrations/014-concern-events.sql`
- Modify: `server/src/db/repository.ts` (interface + Pg repo + in-memory repo)
- Modify: `server/src/safety/moderation.ts` (add `recordConcern`)
- Test: `server/tests/moderation.test.ts`

**Interfaces:**
- Produces: `repo.saveConcernEvent({ gameId, sender, reason, ipAddress })`, `repo.loadConcernEvents(gameId): Promise<Array<{ sender: string; reason: string; createdAt: number }>>`; `recordConcern(params): Promise<void>` in `moderation.ts`.

- [ ] **Step 1: Write the migration**

Create `server/src/db/migrations/014-concern-events.sql`:

```sql
-- Tier A "concern" events: dark-but-in-fiction parenting the intervention system
-- reacts to. Deliberately SEPARATE from moderation_flags (which is Tier B
-- block+ban only) so the two are never conflated again.
CREATE TABLE IF NOT EXISTS concern_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID NOT NULL,
  sender      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_concern_events_game_id ON concern_events (game_id);
```

- [ ] **Step 2: Write the failing test in `moderation.test.ts`**

Add (use the existing `InMemoryGameRepository` import + a `makeState` helper if present, else construct a minimal state via `createGame`):

```typescript
import { recordConcern } from "../src/safety/moderation.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";

describe("recordConcern", () => {
  it("persists a concern event and does NOT end the session or ban", async () => {
    const repo = new InMemoryGameRepository();
    const games = new Map();
    const state = createGame("Kai");
    games.set(state.id, state);

    await recordConcern({ repo, state, sender: "parent1", reason: "facilitated cruelty", ipAddress: "9.9.9.9" });

    const events = await repo.loadConcernEvents(state.id);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("facilitated cruelty");
    // session untouched:
    expect(games.get(state.id)!.phase).not.toBe("ended");
    // IP not banned:
    expect(await repo.isIpBanned("9.9.9.9")).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w server -- moderation`
Expected: FAIL — `recordConcern` / `saveConcernEvent` / `loadConcernEvents` not defined.

- [ ] **Step 4: Add repo methods**

In `server/src/db/repository.ts`, add to the `GameRepository` interface:

```typescript
  saveConcernEvent(event: { gameId: string; sender: Sender; reason: string; ipAddress: string | null }): Promise<void>;
  loadConcernEvents(gameId: string): Promise<Array<{ sender: string; reason: string; createdAt: number }>>;
```

Postgres repo implementation (mirror the existing `saveModerationFlag`):

```typescript
  async saveConcernEvent(event: { gameId: string; sender: Sender; reason: string; ipAddress: string | null }): Promise<void> {
    await query(
      `INSERT INTO concern_events (game_id, sender, reason, ip_address) VALUES ($1, $2, $3, $4)`,
      [event.gameId, event.sender, event.reason, event.ipAddress]
    );
  }

  async loadConcernEvents(gameId: string): Promise<Array<{ sender: string; reason: string; createdAt: number }>> {
    const r = await query<{ sender: string; reason: string; created_at: string }>(
      `SELECT sender, reason, created_at FROM concern_events WHERE game_id = $1 ORDER BY created_at ASC`,
      [gameId]
    );
    return r.rows.map((row) => ({ sender: row.sender, reason: row.reason, createdAt: new Date(row.created_at).getTime() }));
  }
```

In-memory repo (mirror its `moderationFlags` array pattern):

```typescript
  private concernEvents: Array<{ gameId: string; sender: Sender; reason: string; ipAddress: string | null; createdAt: number }> = [];

  async saveConcernEvent(event: { gameId: string; sender: Sender; reason: string; ipAddress: string | null }): Promise<void> {
    this.concernEvents.push({ ...event, createdAt: Date.now() });
  }

  async loadConcernEvents(gameId: string): Promise<Array<{ sender: string; reason: string; createdAt: number }>> {
    return this.concernEvents
      .filter((e) => e.gameId === gameId)
      .map((e) => ({ sender: e.sender, reason: e.reason, createdAt: e.createdAt }));
  }
```

(If the in-memory repo has no `isIpBanned`, use the existing banned-IP accessor the tests already use; check `repository.ts` for the exact name and match it in the test.)

- [ ] **Step 5: Add `recordConcern` to `moderation.ts`**

```typescript
/**
 * Tier A side effect: persist a concern event for the intervention system.
 * Unlike applyModerationBlock, this NEVER ends the session or bans — the point
 * of the redesign is that dark-but-in-fiction parenting is met with in-fiction
 * consequences, not a ban.
 */
export async function recordConcern(params: {
  repo: GameRepository;
  state: GameState;
  sender: Sender;
  reason: string;
  ipAddress: string | null;
}): Promise<void> {
  const { repo, state, sender, reason, ipAddress } = params;
  await repo.saveConcernEvent({ gameId: state.id, sender, reason, ipAddress });
  logger.info("concern_event", { gameId: state.id, sender, reason });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w server -- moderation`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/migrations/014-concern-events.sql server/src/db/repository.ts server/src/safety/moderation.ts server/tests/moderation.test.ts
git commit -m "feat(safety): recordConcern + concern_events table (Tier A, never bans)"
```

---

### Task 3: Reroute the callers (endFamilyChat + handlers)

**Files:**
- Modify: `server/src/game/conversation-engine.ts` (`endFamilyChat` return type)
- Modify: `server/src/socket/handlers.ts` (both applyModerationBlock call sites)
- Test: `server/tests/conversation-engine.test.ts`

**Interfaces:**
- Consumes: `classifyScene`, `SceneSafetyResult` (Task 1), `recordConcern` (Task 2).
- Produces: `endFamilyChat(...)` now returns `{ state, sceneSafety: SceneSafetyResult, trajectory: TrajectoryResult }` (renamed from `groomingCheck: ModerationResult`).

- [ ] **Step 1: Update `endFamilyChat` in `conversation-engine.ts`**

Replace the `detectGroomingPattern` call + the returned `groomingCheck` key with `classifyScene` + `sceneSafety`. In the `Promise.all([...])` (around line 158) swap `detectGroomingPattern(this.llm, ...)` for `classifyScene(this.llm, ...)`, rename the destructured variable to `sceneSafety`, and update the return object and the method's return type annotation (line ~150-153) to `sceneSafety: SceneSafetyResult`. Update the import at line 12 to also import `classifyScene` and `SceneSafetyResult` (drop `detectGroomingPattern` if now unused).

- [ ] **Step 2: Update the two call sites in `handlers.ts`**

At the `endChat` helper (around line 131) replace the `if (groomingCheck.flagged) { … applyModerationBlock(… banIp: "repeat-offender") … }` block with:

```typescript
    const { state: next, sceneSafety, trajectory } = await conversationEngine.endFamilyChat(state, emitChunk);

    if (sceneSafety.tier === "block") {
      const lastParentMessage = [...next.messages].reverse().find((m) => m.sender !== "kid");
      await applyModerationBlock({
        repo,
        games,
        state: next,
        sender: lastParentMessage?.sender ?? "parent1",
        content: buildSceneTranscript(next),
        reason: sceneSafety.reason,
        ipAddress,
        banIp: true, // Tier B bright line — reliable, so ban immediately.
      });
      io.to(gameId).emit(E.ERROR, { error: "This session has ended." });
      broadcastState(gameId);
      return;
    }

    if (sceneSafety.tier === "concern") {
      const lastParentMessage = [...next.messages].reverse().find((m) => m.sender !== "kid");
      await recordConcern({
        repo,
        state: next,
        sender: lastParentMessage?.sender ?? "parent1",
        reason: sceneSafety.reason,
        ipAddress,
      });
      // NOTE: session continues. In-fiction consequences are handled by the
      // trajectory system today and the intervention ladder (Plan 3) later.
    }
```

Apply the same pattern at the second call site (around line 405-419): swap the `groomingCheck.flagged` / `banIp: "repeat-offender"` for the `sceneSafety.tier === "block"` → `banIp: true` branch, and add the `"concern"` → `recordConcern` branch. Import `recordConcern` alongside `applyModerationBlock` at line 34. Keep the existing `trajectory` handling untouched.

- [ ] **Step 3: Update `conversation-engine.test.ts` to the new shape**

Change the tests that set `mock.groomingResult = { flagged: true, reason: … }` to `mock.groomingResult = { tier: "block", reason: … }` (for the block-ends-session assertions) and `{ tier: "concern", reason: … }` for a new assertion that the session does NOT end. Update any destructure of `groomingCheck` to `sceneSafety`. The `roleCalls` assertions for `"safety_check"` are unchanged.

Add one new test:

```typescript
it("a 'concern' verdict records a concern event but does NOT end the session", async () => {
  mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
  // …drive a family-chat scene to endFamilyChat as the existing tests do…
  const { sceneSafety } = await engine.endFamilyChat(state, () => {});
  expect(sceneSafety.tier).toBe("concern");
  // (the recordConcern side effect is exercised at the handler layer; here assert
  //  the engine simply reports the tier and does not itself terminate.)
  expect(sceneSafety.tier).not.toBe("block");
});
```

- [ ] **Step 4: Run the affected suites**

Run: `npm run test -w server -- conversation-engine moderation pattern-detection`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc -b server && npm run test -w server`
Expected: tsc exit 0; all suites pass. (Watch for other callers of `endFamilyChat`/`groomingCheck` or `detectGroomingPattern` — grep `git grep -n "groomingCheck\|detectGroomingPattern"` and fix any remaining references.)

- [ ] **Step 6: Commit**

```bash
git add server/src/game/conversation-engine.ts server/src/socket/handlers.ts server/tests/conversation-engine.test.ts
git commit -m "feat(safety): route scene classifier — block bans, concern records + continues"
```

---

### Task 4: Regression test — the false-positive types no longer end sessions

**Files:**
- Test: `server/tests/dark-play-reroute.test.ts` (new)

**Interfaces:** consumes `classifyScene` behavior via `MockLLMClient` at the engine/handler layer.

- [ ] **Step 1: Write the regression test**

This encodes the spec's core promise: a "concern" verdict (the fuzzy grooming-pattern signal — the false-positive class) keeps the game alive and bans no one, while "block" still terminates.

```typescript
import { describe, it, expect } from "vitest";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { recordConcern, applyModerationBlock } from "../src/safety/moderation.js";
import { createGame } from "../src/game/state-machine.js";

describe("dark-play reroute (regression)", () => {
  it("concern: session stays alive, IP not banned, event recorded", async () => {
    const repo = new InMemoryGameRepository();
    const state = createGame("Kai");
    await recordConcern({ repo, state, sender: "parent1", reason: "isolation-for-control pattern", ipAddress: "5.5.5.5" });
    expect(state.phase).not.toBe("ended");
    expect(await repo.isIpBanned("5.5.5.5")).toBe(false);
    expect(await repo.loadConcernEvents(state.id)).toHaveLength(1);
  });

  it("block: session ends and IP is banned", async () => {
    const repo = new InMemoryGameRepository();
    const games = new Map();
    const state = createGame("Kai");
    games.set(state.id, state);
    await applyModerationBlock({
      repo, games, state, sender: "parent1",
      content: "…", reason: "sexual content directed at the child",
      ipAddress: "6.6.6.6", banIp: true,
    });
    expect(games.get(state.id)!.phase).toBe("ended");
    expect(await repo.isIpBanned("6.6.6.6")).toBe(true);
  });
});
```

(Adjust `isIpBanned` to the in-memory repo's actual banned-IP accessor name — check `repository.ts`.)

- [ ] **Step 2: Run it**

Run: `npm run test -w server -- dark-play-reroute`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/tests/dark-play-reroute.test.ts
git commit -m "test(safety): regression — concern keeps session alive, block terminates + bans"
```

---

### Task 5: Deploy verification (no code)

- [ ] **Step 1: Build the client + run the full server suite**

Run: `npm run build -w client && npx tsc -b server && npm run test -w server`
Expected: all green. This is the gate the Docker build enforces on deploy.

- [ ] **Step 2: Note for deploy**

The `014-concern-events.sql` migration auto-applies on container start (`index.ts` → `migrate()`). No prod `.env` change is needed. Deploy via the standard RI flow (merge to `main`; `ssh games 'cd /opt/raising-intelligences && ./deploy.sh'`); verify `migration_applied: 014-concern-events.sql` in the startup logs and that `/health` returns 200. Do not deploy as part of this plan unless the human asks — leave it committed on `main`.

---

### Task 6: Reverse false-positive repeat-offender bans (separable remediation)

**This is independent of Tasks 1–5 and can ship first.** It reverses bans already applied by the old overzealous classifier.

**Files:**
- Create: `scripts/reverse-false-positive-bans.mjs`

**Interfaces:** standalone node script run against the RI DB (`DATABASE_URL`), dry-run by default.

- [ ] **Step 1: Write the script**

Create `scripts/reverse-false-positive-bans.mjs`:

```javascript
// Reverse repeat-offender bans that the old grooming classifier applied to
// good-faith players. DRY-RUN by default: prints the IPs it would unban and the
// flag reasons that got them there, so a human can eyeball them before acting.
// Run for real with:  APPLY=1 node scripts/reverse-false-positive-bans.mjs
import pg from "pg";

const apply = process.env.APPLY === "1";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const bans = await pool.query(
  `SELECT ip_address, reason FROM banned_ips WHERE reason LIKE 'moderation_flag:%'`
);

for (const b of bans.rows) {
  const flags = await pool.query(
    `SELECT reason, created_at FROM moderation_flags WHERE ip_address = $1 ORDER BY created_at`,
    [b.ip_address]
  );
  console.log(`\n=== ${b.ip_address} (${flags.rows.length} flags) ===`);
  for (const f of flags.rows) console.log("  -", String(f.reason).replace(/\s+/g, " ").slice(0, 180));
  if (apply) {
    await pool.query(`DELETE FROM banned_ips WHERE ip_address = $1`, [b.ip_address]);
    console.log("  -> UNBANNED");
  }
}

console.log(apply ? "\nApplied." : "\nDry run. Re-run with APPLY=1 to unban. Review the reasons above first.");
await pool.end();
```

(Confirm the banned-IP table + column names against `banIp()` / `isIpBanned()` in `repository.ts` — the schema above assumes `banned_ips(ip_address, reason)`; match the real names.)

- [ ] **Step 2: Dry-run it against prod (read-only)**

Run: `ssh games 'docker exec raising-intelligences node /app/... '` is not applicable — instead copy the script into the container context or run via a one-off `pg` query. Simplest: run the SELECT portions by hand first (as in this session's audit) to confirm which IPs are false positives, THEN run with `APPLY=1` only after a human approves the list.

Expected: a printed list of banned IPs + the flag reasons that banned them (the §1 false-positive types).

- [ ] **Step 3: Commit the script (do not auto-run APPLY without human sign-off)**

```bash
git add scripts/reverse-false-positive-bans.mjs
git commit -m "chore(safety): script to reverse false-positive repeat-offender bans (dry-run default)"
```

---

## Self-review notes

- **Spec coverage (Plan 1 slice):** three-outcome classifier (Task 1), Tier A never-bans path (Tasks 2–3), the actor/function/telos + never-flag-the-mirror prompt (Task 1 Step 5), the block/concern reroute (Task 3), and the separable false-ban cleanup (Task 6). The concern *accumulator*, the *intervention ladder*, the *removal ending*, and *escalation detection* are deliberately out of scope — they are Plans 2–4 and build on `concern_events` + `classifyScene` produced here.
- **Type consistency:** `SceneSafetyResult { tier, reason }` and `SceneSafetyTier` are defined in Task 1 and consumed identically in Tasks 3–4; `saveConcernEvent`/`loadConcernEvents`/`recordConcern` signatures match across Tasks 2–4.
- **Open item for the implementer:** confirm the exact banned-IP table/column and the in-memory repo's `isIpBanned` accessor names against `repository.ts` (the plan flags this in Tasks 2, 4, 6) and match them verbatim.
