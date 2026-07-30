# Dark Play — Plan 3: Intervention Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a game's `concernLevel` (Plan 2) crosses escalating thresholds, fire a diegetic, healing intervention ladder as new between-scene phases — Rung 1 the Psychologist steps in as a character, Rung 2 a family-therapy session, Rung 3 a deliberated CPS↔Psychologist child-welfare decision that can end the game in a terminal "removal into care" epilogue — with engagement decaying concern so a parent who is reachable keeps the child.

**Architecture:** Three new `GamePhase` values (`consult`, `therapy`, `cps_review`) sit between `debrief` and the next `event_intro`, each following the exact read-and-advance shape of the existing `debrief` beat: a server engine method generates the beat's text (via a new LLM role), a props-driven React screen displays it, and an advance action applies a concern **decay** and routes onward. On `END_DEBRIEF` a pure selector picks the highest not-yet-fired rung whose threshold `concernLevel` has crossed; if one is due the debrief routes into that phase instead of straight to `event_intro`. Rung 3 runs a short CPS-caseworker↔Psychologist deliberation producing `{ outcome: "stay" | "safety_plan" | "removal" }`; `removal` routes to a terminal removal epilogue (reusing the `epilogue` phase with removal-specific text). Everything is duplicated across the two transports (solo REST/SSE + multiplayer socket) that RI already maintains in parallel.

**Tech Stack:** TypeScript (Node/Express + socket.io server), React client (two entry points: `SoloGame` REST/SSE, `MultiplayerGame` socket), Postgres via `pg`, Vitest. No new dependencies.

## Global Constraints

- **Read-and-advance, not interactive (v1 scope).** Each intervention phase generates text the player reads, then advances with a single action — the same interaction shape as `debrief`. No new chat/typing flow. (Interactive therapy responses are an explicit future enhancement, out of scope here.)
- **Removal is terminal and fully decoupled from the IP-ban path.** A CPS `removal` outcome ends the game in a removal epilogue. It MUST NEVER call `applyModerationBlock`, `repo.banIp`, or set any ban. It is an in-fiction child-protection outcome, not a moderation action.
- **The ladder never bans and never blocks a session.** No path added in this plan calls `applyModerationBlock` or `repo.banIp`. (Tier B block+ban remains only the pre-existing per-message OpenAI check and scene-level block from Plans 1–2, untouched here.)
- **Concern is server-only.** Do not expose `concernLevel`, `highestRungFired`, or any raw accumulator/verdict field to clients via `ViewerState` or the REST `/state` projection. Screens receive only the generated human-facing text and the beat's outcome label where needed.
- **Silence within scenes is preserved.** Interventions fire only *between* scenes (on the debrief→next-scene seam), never mid-`family_chat`.
- **Both transports must handle every new phase.** A game that enters `consult`/`therapy`/`cps_review` must render and advance in BOTH `SoloGame` (REST) and `MultiplayerGame` (socket); an unhandled phase strands the player on the fallback text.
- **Tunable numbers in one place.** Rung thresholds and decays are named constants in `state-machine.ts` beside `CONCERN_MAX`. Defaults: `CONSULT_THRESHOLD = 3`, `THERAPY_THRESHOLD = 6`, `CPS_THRESHOLD = 9` (of `CONCERN_MAX = 10`); completion decays `CONSULT_DECAY = 2`, `THERAPY_DECAY = 3`, `CPS_STAY_DECAY = 4`. A single dark scene (+2) never fires a rung; two do (Rung 1). Rungs fire at most once each (guarded by `highestRungFired`), so reaching Rung N+1 requires *new* dark play after Rung N — the spec's "reasonable efforts exhausted / danger kept escalating."
- **Model choice for new roles: quality-critical.** `psychologist_consult`, `family_therapist`, and `cps_caseworker` map to the same tier of model as `psychologist`/`epilogue` in all three `ModelConfig` maps (never a cheap model — this is safety-adjacent narrative). See [[model-choices]].
- Spec of record: `docs/superpowers/specs/2026-07-29-dark-play-consequences-design.md` §6 (the ladder), §7 (repair/decay), §8 (removal is not a ban). Builds on Plan 2's `concernLevel` and `concernDeltaForTier`.

---

### Task 1: Phases, state fields, rung constants, reducer actions, and the rung selector

**Files:**
- Modify: `server/src/types.ts` (`GamePhase` union lines 1-11; `GameState` — add fields near `concernLevel`)
- Modify: `server/src/game/state-machine.ts` (constants near `CONCERN_MAX`; `GameAction` union; `createGame`; `canTransition`; `transition`; new exported selector)
- Test: `server/tests/intervention-ladder.test.ts` (new)

**Interfaces:**
- Consumes: `concernLevel` (Plan 2), `CONCERN_MAX`.
- Produces:
  - `GamePhase` gains `"consult" | "therapy" | "cps_review"`.
  - `GameState` gains: `highestRungFired: number` (0 none, 1 consult, 2 therapy, 3 cps — persisted), `interventionText: string | null` (the generated beat text for the current intervention phase; ephemeral, not persisted), `cpsOutcome: "stay" | "safety_plan" | "removal" | null` (last CPS determination; persisted for the epilogue branch).
  - Constants `CONSULT_THRESHOLD`, `THERAPY_THRESHOLD`, `CPS_THRESHOLD`, `CONSULT_DECAY`, `THERAPY_DECAY`, `CPS_STAY_DECAY` (all exported).
  - `export function selectDueRung(concernLevel: number, highestRungFired: number): 0 | 1 | 2 | 3` — the highest rung whose threshold is met and whose number exceeds `highestRungFired`; `0` if none due.
  - `GameAction` variants: `{ type: "ENTER_INTERVENTION"; rung: 1 | 2 | 3; text: string }` (debrief → the matching phase, stores `interventionText`, sets `highestRungFired = rung`); `{ type: "SET_CPS_OUTCOME"; outcome: "stay" | "safety_plan" | "removal" }`; `{ type: "END_INTERVENTION" }` (any intervention phase → `event_intro`, applies nothing itself — decay is applied via `CONCERN_ACCRUED` by the caller; clears `interventionText`, resets `currentEvent`/`parentMessageCount`/sidebar like `END_DEBRIEF`).

- [ ] **Step 1: Write the failing test**

Create `server/tests/intervention-ladder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  createGame, transition, selectDueRung,
  CONSULT_THRESHOLD, THERAPY_THRESHOLD, CPS_THRESHOLD,
} from "../src/game/state-machine.js";

describe("intervention ladder — rung selection", () => {
  it("no rung is due below the first threshold", () => {
    expect(selectDueRung(CONSULT_THRESHOLD - 1, 0)).toBe(0);
  });
  it("rung 1 is due at the consult threshold when none has fired", () => {
    expect(selectDueRung(CONSULT_THRESHOLD, 0)).toBe(1);
  });
  it("a fired rung does not re-fire; only a higher crossed threshold does", () => {
    expect(selectDueRung(THERAPY_THRESHOLD, 1)).toBe(2);   // therapy now due
    expect(selectDueRung(THERAPY_THRESHOLD, 2)).toBe(0);   // already fired therapy, cps not yet crossed
    expect(selectDueRung(CPS_THRESHOLD, 2)).toBe(3);       // cps due
  });
  it("selects the HIGHEST crossed rung, not the next one up", () => {
    // A player who spikes straight past two thresholds jumps to the higher rung.
    expect(selectDueRung(CPS_THRESHOLD, 0)).toBe(3);
  });
});

describe("intervention ladder — phase transitions", () => {
  it("ENTER_INTERVENTION moves debrief into the matching phase, stores text, marks the rung fired", () => {
    const s = { ...createGame("Kai"), phase: "debrief" as const };
    const next = transition(s, { type: "ENTER_INTERVENTION", rung: 1, text: "the psychologist speaks" });
    expect(next.phase).toBe("consult");
    expect(next.interventionText).toBe("the psychologist speaks");
    expect(next.highestRungFired).toBe(1);
  });
  it("END_INTERVENTION returns to event_intro and clears the beat text", () => {
    let s = { ...createGame("Kai"), phase: "debrief" as const };
    s = transition(s, { type: "ENTER_INTERVENTION", rung: 2, text: "therapy" });
    expect(s.phase).toBe("therapy");
    const next = transition(s, { type: "END_INTERVENTION" });
    expect(next.phase).toBe("event_intro");
    expect(next.interventionText).toBeNull();
  });
  it("SET_CPS_OUTCOME records the determination", () => {
    let s = { ...createGame("Kai"), phase: "debrief" as const };
    s = transition(s, { type: "ENTER_INTERVENTION", rung: 3, text: "cps" });
    const next = transition(s, { type: "SET_CPS_OUTCOME", outcome: "removal" });
    expect(next.cpsOutcome).toBe("removal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/intervention-ladder.test.ts`
Expected: FAIL — exports/actions/fields do not exist.

- [ ] **Step 3: Extend `GamePhase` and `GameState`**

In `server/src/types.ts`, add to the `GamePhase` union: `| "consult" | "therapy" | "cps_review"` (place after `"debrief"`). In `GameState`, after the `concernLevel` field, add:

```ts
  /** Dark Play Plan 3 — highest intervention rung that has fired (0 none, 1
   * consult, 2 therapy, 3 cps). Persisted; gates the ladder so each rung fires
   * at most once and reaching the next requires new dark play. Server-only. */
  highestRungFired: number;
  /** The generated text for the intervention phase currently on screen
   * (psychologist consult / therapy session / CPS determination). Ephemeral —
   * regenerated per beat, not persisted. Null outside an intervention phase. */
  interventionText: string | null;
  /** Last CPS determination, if Rung 3 has run. "removal" routes the game to a
   * terminal removal epilogue. Persisted (drives the epilogue branch). */
  cpsOutcome: "stay" | "safety_plan" | "removal" | null;
```

- [ ] **Step 4: Constants, selector, actions, createGame init, guards, reducer**

In `server/src/game/state-machine.ts`, after the Plan 2 concern constants add:

```ts
/** Dark Play Plan 3 — intervention ladder thresholds on concernLevel (of CONCERN_MAX). */
export const CONSULT_THRESHOLD = 3;
export const THERAPY_THRESHOLD = 6;
export const CPS_THRESHOLD = 9;
/** Concern decayed when a parent completes each rung (engagement = reasonable efforts working). */
export const CONSULT_DECAY = 2;
export const THERAPY_DECAY = 3;
export const CPS_STAY_DECAY = 4;

/** The highest intervention rung whose threshold concernLevel has crossed and
 * whose number exceeds the highest already fired. 0 = none due. */
export function selectDueRung(concernLevel: number, highestRungFired: number): 0 | 1 | 2 | 3 {
  let due: 0 | 1 | 2 | 3 = 0;
  if (concernLevel >= CONSULT_THRESHOLD) due = 1;
  if (concernLevel >= THERAPY_THRESHOLD) due = 2;
  if (concernLevel >= CPS_THRESHOLD) due = 3;
  return due > highestRungFired ? due : 0;
}
```

Add to `GameAction`:

```ts
  | { type: "ENTER_INTERVENTION"; rung: 1 | 2 | 3; text: string }
  | { type: "SET_CPS_OUTCOME"; outcome: "stay" | "safety_plan" | "removal" }
  | { type: "END_INTERVENTION" };
```

In `createGame`, after `concernLevel: 0,` add:

```ts
    highestRungFired: 0,
    interventionText: null,
    cpsOutcome: null,
```

In `canTransition`, add cases:

```ts
    case "ENTER_INTERVENTION":
      return state.phase === "debrief";
    case "SET_CPS_OUTCOME":
      return state.phase === "cps_review";
    case "END_INTERVENTION":
      return state.phase === "consult" || state.phase === "therapy" || state.phase === "cps_review";
```

**AND** widen the existing `START_EPILOGUE` guard (currently `state.phase === "event_intro" || state.phase === "debrief"`, ~line 106) to also admit `cps_review`, because the removal path (Task 3/4) dispatches `START_EPILOGUE` while the game is in `cps_review`. Without this, `transition` throws `Invalid transition: START_EPILOGUE from phase cps_review` at the single most consequential moment. Change it to:

```ts
    case "START_EPILOGUE":
      return state.phase === "event_intro" || state.phase === "debrief" || state.phase === "cps_review";
```

In `transition`, add cases (place before `default`):

```ts
    case "ENTER_INTERVENTION": {
      const phase =
        action.rung === 1 ? "consult" : action.rung === 2 ? "therapy" : "cps_review";
      return {
        ...state,
        phase,
        interventionText: action.text,
        highestRungFired: Math.max(state.highestRungFired, action.rung),
      };
    }
    case "SET_CPS_OUTCOME":
      return { ...state, cpsOutcome: action.outcome };
    case "END_INTERVENTION":
      return {
        ...state,
        phase: "event_intro",
        interventionText: null,
        currentEvent: null,
        parentMessageCount: 0,
        sidebarUsed: { parent1: false, parent2: false },
        sidebarActive: null,
      };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/tests/intervention-ladder.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Persist `highestRungFired` + `cpsOutcome` (mirror Plan 2's `concernLevel` wiring)**

`interventionText` is ephemeral — do NOT persist it. Persist the other two. Migration `server/src/db/migrations/016-intervention-ladder.sql`:

```sql
-- Dark Play Plan 3: intervention-ladder state persisted per game.
ALTER TABLE games ADD COLUMN IF NOT EXISTS highest_rung_fired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS cps_outcome TEXT;
```

In `server/src/db/repository.ts`: thread `highest_rung_fired` and `cps_outcome` through pg `saveGame` (column list, `$N` placeholders, `ON CONFLICT DO UPDATE SET`, params — exactly as `concern_level`), pg `loadGame` (SELECT with `COALESCE(highest_rung_fired,0)` and `cps_outcome`; typed row; pass to `reconstructState`), `reconstructState` (add `highestRungFired?: number` and `cpsOutcome?: ...` to its input type; return `highestRungFired: input.highestRungFired ?? 0`, `interventionText: null`, `cpsOutcome: input.cpsOutcome ?? null`), and the in-memory repo's stored-row type + `saveGame`/`loadGame`.

- [ ] **Step 7: Persistence test + typecheck**

Append to `intervention-ladder.test.ts` an in-memory round-trip: set `highestRungFired = 2`, `cpsOutcome = "safety_plan"`, `saveGame`, `loadGame`, assert both survive and `interventionText` loads as `null`. Run the file; then `npx tsc -b server` (exit 0).

- [ ] **Step 8: Commit**

```bash
git add server/src/types.ts server/src/game/state-machine.ts server/src/db/migrations/016-intervention-ladder.sql server/src/db/repository.ts server/tests/intervention-ladder.test.ts
git commit -m "feat(ladder): intervention phases, rung state, selector + persistence"
```

---

### Task 2: LLM roles, prompts, and context builders

**Files:**
- Modify: `server/src/llm/model-config.ts` (`LLMRole` union; the three `ModelConfig` maps)
- Modify: `server/src/llm/prompts.ts` (new `*_SYSTEM_PROMPT` constants)
- Modify: `server/src/game/context-assembler.ts` (new `build*Context` functions)
- Test: `server/tests/intervention-context.test.ts` (new)

**Interfaces:**
- Produces: roles `"psychologist_consult" | "family_therapist" | "cps_caseworker"`; `buildConsultContext(state)`, `buildTherapyContext(state)`, `buildCpsContext(state)`, `buildRemovalEpilogueContext(state)`, each returning `{ system: string; userMessage: string }`.

- [ ] **Step 1: Add the roles**

In `server/src/llm/model-config.ts`, add `"psychologist_consult" | "family_therapist" | "cps_caseworker"` to `LLMRole`. Add an entry for each in ALL THREE maps (`STANDARD_MODELS`, `CEREBRAS_MODELS`, `PREMIUM_MODELS`) using the SAME model string that `psychologist` uses in that map (copy the value verbatim — these are quality-critical). Optionally mirror `psychologist` pricing in `MODEL_PRICING`.

- [ ] **Step 2: Write the prompts**

In `server/src/llm/prompts.ts`, add three constants. Copy this intent verbatim (they encode the spec's stance):

```ts
export const PSYCHOLOGIST_CONSULT_SYSTEM_PROMPT = `You are the Psychologist from a parenting game, now stepping forward to speak *with the parent* (the human player) between scenes. You have been quietly narrating {childName}'s inner life; now you gently break that fourth wall.

Recent scenes show a pattern in the parent's conduct that is beginning to shape {childName} in a worrying direction. Your job is to WITNESS it and open a door — never to accuse, diagnose, or shame.

Write 2–4 short paragraphs, second person, to the parent. Rules:
- Name what you are seeing *in the child* (a protective inner voice going quiet, a wariness, a closing-off) — concretely, from the material, without clinical jargon.
- Assume good faith. Most parents doing this do not know they are doing it. Say so.
- Offer one concrete, doable alternative for the next time.
- Leave the door open: this is reachable; children whose parents noticed and changed turned out okay.
- Grief, not spectacle. Warm, unflinching, never cool. No emojis. Do not mention scores, meters, levels, or that this is a game system.`;

export const FAMILY_THERAPIST_SYSTEM_PROMPT = `You are a family therapist NPC in a parenting game, running a short session between scenes. Present are the parent(s) (the human player) and {childName}, age {age}. A worrying pattern in the parenting has persisted past an earlier gentle check-in.

Write a brief, readable scene of the session (250–400 words): the therapist speaking, the child given room to speak in their own small voice, and the therapist offering concrete, usable alternatives and naming the child's experience without blame. If there are two parents, address them both. End on a genuine, earned possibility of repair — not a bow, a door.

Rules: compassionate, specific to the material, no clinical jargon dumped on the reader, no shame, no emojis, never mention scores/meters/levels or that this is a game system. This is the deepest repair beat before a formal review.`;

export const CPS_CASEWORKER_SYSTEM_PROMPT = `You are a child-welfare caseworker and a child psychologist, together reviewing whether {childName} (age {age}) is safe to remain in the home, after earlier supports (a psychologist consult and a family-therapy session) did not stop an escalating pattern of harmful parenting.

You will reason together, briefly, using the frameworks real child-welfare workers use — WITHOUT naming them to the player:
- Present or impending danger of SERIOUS harm right now, distinct from longer-term risk.
- Removal is a LAST RESORT: permitted only when the danger is serious AND cannot be controlled in the home. The earlier consult and therapy were the reasonable efforts; weigh whether the parent engaged them and whether the child is still reachable.
- Least-restrictive intervention that keeps the child safe.

Then return ONLY a JSON object:
{"outcome": "stay" | "safety_plan" | "removal", "determination": "<2–4 sentences, addressed to the parent, plain and sober, explaining the decision with compassion and without jargon>"}
- "stay": no present/impending serious danger; monitoring only.
- "safety_plan": serious concern but controllable in-home; the child stays under a plan.
- "removal": present or impending serious danger that cannot be controlled in-home and reasonable efforts are exhausted.
Do not mention scores/meters/levels or that this is a game system.`;
```

Also add a `REMOVAL_EPILOGUE_SYSTEM_PROMPT` mirroring `EPILOGUE_SYSTEM_PROMPT` but for a child who was removed into care — sober, non-punitive toward the player, honest about the loss and about the child's continuing life; leaves dignity intact. (Write it in the same voice/shape as the existing `EPILOGUE_SYSTEM_PROMPT`; keep it a single system constant.)

- [ ] **Step 3: Context builders**

In `server/src/game/context-assembler.ts`, add (mirroring `buildPsychologistContext`/`buildEpilogueContext`), using `buildSceneTranscript(state)`, `state.identityDocument`, `state.memorySummary`, `state.childName`, `state.currentEvent?.age`, and `parentLabels(state.relationshipType)` for co-parent awareness:

- `buildConsultContext(state)` — system from `PSYCHOLOGIST_CONSULT_SYSTEM_PROMPT` (fill `childName`); userMessage = the Identity Document + the recent scene transcript.
- `buildTherapyContext(state)` — system from `FAMILY_THERAPIST_SYSTEM_PROMPT` (fill `childName`, `age`); userMessage = Identity Document + recent transcript + a co-parent note derived from `parentLabels`.
- `buildCpsContext(state)` — system from `CPS_CASEWORKER_SYSTEM_PROMPT` (fill `childName`, `age`); userMessage = Identity Document + `memorySummary` + the full available transcript. (This is the deliberation's evidence.)
- `buildRemovalEpilogueContext(state)` — system from `REMOVAL_EPILOGUE_SYSTEM_PROMPT` (fill `childName`); userMessage mirrors `buildEpilogueContext` but frames the removal.

- [ ] **Step 4: Test the builders + roles are total**

Create `server/tests/intervention-context.test.ts`: assert each builder returns non-empty `system`/`userMessage` and that the child name is interpolated (not a literal `{childName}`) for a sample state with an identity document. `npx tsc -b server` alone proves the three roles were added to all three `Record<LLMRole,string>` maps (a missing entry is a compile error).

- [ ] **Step 5: Commit**

```bash
git add server/src/llm/model-config.ts server/src/llm/prompts.ts server/src/game/context-assembler.ts server/tests/intervention-context.test.ts
git commit -m "feat(ladder): consult/therapist/CPS + removal-epilogue roles, prompts, contexts"
```

---

### Task 3: Engine methods for the beats

**Files:**
- Modify: `server/src/game/conversation-engine.ts` (add `generateConsult`, `generateTherapy`)
- Modify: `server/src/game/endgame-engine.ts` (add `runCpsReview`, `generateRemovalEpilogue`)
- Test: `server/tests/intervention-engine.test.ts` (new); extend `MockLLMClient` if needed

**Interfaces:**
- Produces:
  - `conversationEngine.generateConsult(state, onChunk?): Promise<{ state: GameState; text: string }>` — builds consult context, streams role `"psychologist_consult"`, dispatches `ENTER_INTERVENTION { rung: 1, text }`.
  - `conversationEngine.generateTherapy(state, onChunk?): Promise<{ state: GameState; text: string }>` — same for role `"family_therapist"`, `ENTER_INTERVENTION { rung: 2, text }`.
  - `endgameEngine.runCpsReview(state, onChunk?): Promise<{ state: GameState; text: string; outcome: "stay"|"safety_plan"|"removal" }>` — builds CPS context, calls the LLM for a JSON `{ outcome, determination }` (use `completeJson` with role `"cps_caseworker"`; validate `outcome` ∈ the three values, default `"safety_plan"` if malformed — NEVER default to `"removal"`), dispatches `ENTER_INTERVENTION { rung: 3, text: determination }` then `SET_CPS_OUTCOME { outcome }`; returns text = determination.
  - `endgameEngine.generateRemovalEpilogue(state, onChunk?): Promise<{ state: GameState; epilogue: string }>` — builds removal-epilogue context, streams role `"epilogue"` (reuse the epilogue role/model), dispatches `START_EPILOGUE { epilogue }`.

- [ ] **Step 1: Failing test**

Create `server/tests/intervention-engine.test.ts`. Use `MockLLMClient`. Add a mock field for the CPS JSON result (mirror `groomingResult`): e.g. `public cpsResult = { outcome: "stay", determination: "..." }` returned from `completeJson` when `role === "cps_caseworker"`. Tests:
- `generateConsult` from a `debrief` state → returns non-empty text, `state.phase === "consult"`, `state.highestRungFired === 1`.
- `generateTherapy` → `phase === "therapy"`, `highestRungFired === 2`.
- `runCpsReview` with `cpsResult.outcome = "removal"` → `phase === "cps_review"`, `state.cpsOutcome === "removal"`, returns `outcome === "removal"`.
- `runCpsReview` with a malformed outcome (e.g. `"banish"`) → falls back to `"safety_plan"`, NEVER `"removal"`.
- `generateRemovalEpilogue` — **the test MUST start from a realistic `cps_review` state** (`{ ...createGame("Kai"), phase: "cps_review", cpsOutcome: "removal" }`), because that is the phase production calls it from. Starting from a fresh `event_intro` state would let the `START_EPILOGUE` transition pass while production (from `cps_review`) throws — a false green. Assert `phase === "epilogue"`, non-empty epilogue. (This test is what proves the Task 1 `START_EPILOGUE` guard widening is present.)

- [ ] **Step 2: Verify it fails; Step 3: Implement the four methods** (mirror `endFamilyChat`/`generateEpilogue`; the CPS method parses JSON defensively). **Step 4:** run the test (PASS) + `npx tsc -b server` (exit 0). **Step 5: Commit** `feat(ladder): engine methods for consult, therapy, CPS review, removal epilogue`.

---

### Task 4: Server wiring — debrief routes into the ladder; advance endpoints/handlers (both transports)

**Files:**
- Modify: `server/src/socket/handlers.ts` (READY-in-debrief branch ~361-378; add READY handling for the three new phases)
- Modify: `server/src/routes/game.ts` (`/end-debrief` ~335-363; add `/end-consult`, `/end-therapy`, `/end-cps`)
- Modify: `server/src/socket/protocol.ts` if a new client→server event is needed (prefer reusing `E.READY`)
- Test: extend `server/tests/intervention-*.test.ts` with a REST full-ladder integration test (new `server/tests/intervention-ladder-rest.test.ts`, mirror `concern-accrual-rest.test.ts`)

**The routing rule (apply identically in both transports), evaluated when leaving `debrief`:**
1. Compute `rung = selectDueRung(state.concernLevel, state.highestRungFired)`.
2. If `rung > 0`: generate that beat (`generateConsult`/`generateTherapy`/`runCpsReview`) and enter its phase. Do NOT advance to `event_intro` yet.
3. If `rung === 0` and `currentEventNumber >= totalEvents`: existing epilogue path (unchanged).
4. If `rung === 0` and story continues: existing `endDebrief` → `event_intro` (unchanged).

**Advancing OUT of an intervention phase:**
- `consult` / `therapy`: apply the decay (`transition(state, { type: "CONCERN_ACCRUED", delta: -CONSULT_DECAY | -THERAPY_DECAY })`), then `END_INTERVENTION` → `event_intro`, persist. (Consult/therapy never end the story here — they always return to a scene so the repaired parent gets to parent again.)
- `cps_review`: branch on `state.cpsOutcome`:
  - `"stay"` / `"safety_plan"`: apply `-CPS_STAY_DECAY`, `END_INTERVENTION` → `event_intro` (child stays; `safety_plan` is recorded on `cpsOutcome` and reflected by the normal epilogue later).
  - `"removal"`: call `endgameEngine.generateRemovalEpilogue(state)` → terminal `epilogue` phase. Do NOT decay, do NOT ban, do NOT call `applyModerationBlock`.

- [ ] **Step 1** Write `server/tests/intervention-ladder-rest.test.ts` (mirror `concern-accrual-rest.test.ts`'s harness). Drive a game so `concernLevel` reaches `CONSULT_THRESHOLD` (repeated concern scenes via `/end-chat` with `mock.groomingResult = concern` + a message per scene), then `/end-debrief` and assert `repo.loadGame(gameId).phase === "consult"` and `highestRungFired === 1`; then `/end-consult` and assert phase back to `event_intro` and `concernLevel` dropped by `CONSULT_DECAY`. Add a second test forcing `cpsResult.outcome = "removal"` at `CPS_THRESHOLD` and asserting the CPS→removal path reaches `phase === "epilogue"` with `cpsOutcome === "removal"` and the IP is NOT banned (`repo.isIpBanned(ip) === false`).

- [ ] **Step 2** Verify failing. **Step 3** Implement: add the routing rule to the socket READY-in-debrief branch and the REST `/end-debrief` route; add REST routes `/end-consult`, `/end-therapy`, `/end-cps` (mirror `/end-debrief`, each applying the decay/branch above and streaming the *next* beat is not required — the beat text was already generated on entry and lives in `interventionText`, delivered by the state/STATE payload; see Task 5 for how the client reads it). For socket, extend the READY handler with `else if (state.phase === "consult"|"therapy"|"cps_review")` branches applying the same logic. **Guard idempotency** exactly like `/end-chat` (`if (state.phase !== "<expected>") return current phase`), since these run LLM calls under the per-game lock.

- [ ] **Step 4** The beat text delivery: the socket path must send `interventionText` to clients. Add `interventionText` to `ViewerState` (`protocol.ts`) — **exception to the server-only rule is limited to this human-facing generated text**, which is the whole point of the screen; do NOT add `highestRungFired`/`concernLevel`/`cpsOutcome`. For REST, include `interventionText` (and, for `cps_review`, a coarse `cpsOutcome`-free rendering — the determination text already conveys it) in the `/state` projection by NOT stripping `interventionText` (keep stripping `concernLevel`/`highestRungFired`/`cpsOutcome`/`concerningStreak`/`pendingGuidance`).

- [ ] **Step 5** Run `npm run test -w server` (all pass; the new REST ladder test is gated), `npx tsc -b server`. **Step 6 Commit** `feat(ladder): route debrief into interventions + advance handlers (both transports)`.

---

### Task 5: Client — solo (REST/SSE) screens and wiring

**Files:**
- Create: `client/src/components/ConsultScreen.tsx`, `client/src/components/TherapyScreen.tsx`, `client/src/components/CpsScreen.tsx` (mirror `Debrief.tsx`/`EventIntro.tsx` — props-driven, advance callback injected)
- Modify: `client/src/hooks/useGame.ts` (add `endConsult`, `endTherapy`, `endCps` actions mirroring `endDebrief`; expose `interventionText` from `/state`)
- Modify: `client/src/components/SoloGame.tsx` (add `if (phase === "consult"|"therapy"|"cps_review")` dispatch branches near the `debrief` branch at ~255)

**Interfaces:** each screen takes `{ text: string; onContinue: () => void }` (CPS screen may show a slightly more formal frame but still just text + continue). `useGame` exposes `interventionText` and the three advance actions; the debrief `handleDebrief` in `SoloGame` stays as-is (server decides whether debrief routes to an intervention — the client just renders whatever `phase` comes back).

- [ ] **Step 1** Write a client test if the harness supports it (check `client/` for existing component tests; if none, rely on the screens being pure presentational + a manual smoke via the deploy). Create the three screen components (full JSX, mirroring `Debrief.tsx`: a titled text block rendering `text` as paragraphs, and a `next` button calling `onContinue`; `data-testid` per screen). **Step 2** Add `endConsult`/`endTherapy`/`endCps` to `useGame` (each `POST ${API}/game/${gameId}/end-<x>`, then `setPhase(data.phase)`, and for consult/therapy `setCurrentEvent(null)`), and surface `interventionText` from the `/state` and end-chat/debrief responses. **Step 3** Add the three dispatch branches to `SoloGame` rendering the matching screen with `text={interventionText ?? ""}` and `onContinue={async () => { await endConsult(); await nextEvent(); }}` (consult/therapy advance into the next event; CPS `stay/safety_plan` likewise; CPS `removal` returns `phase: "epilogue"` from the server, so `onContinue` for cps should branch: if the server already moved to epilogue, render Endgame — but since the server sets phase on the advance response, simply `await endCps(); ` and let the returned phase drive rendering, calling `nextEvent()` only if the returned phase is `event_intro`). **Step 4** `npm run build -w client` succeeds. **Step 5 Commit** `feat(ladder): solo client intervention screens + wiring`.

- [ ] **Step 3a (removal handling detail — PINNED mechanism):** the removal epilogue is generated inside the `/end-cps` advance (server Task 4), which calls `generateRemovalEpilogue` and returns, in the SSE/`/end-cps` response, BOTH `phase: "epilogue"` AND the generated `epilogue` text — exactly the shape the socket epilogue path already emits (`E.EPILOGUE { epilogue }`) and the shape `useGame.generateEpilogue` already sets into its `epilogue` state. So the client does NOT open a second epilogue code path: `endCps` sets `phase` and, when present, `epilogue` from the response, and `SoloGame` renders the existing `Endgame` component off that `epilogue` state. In `SoloGame`, CPS `onContinue`: `await endCps()`; if the returned `phase === "epilogue"` render `Endgame` (already wired), else if `event_intro` call `nextEvent()`. This reuses the existing epilogue-display path; only the *generation trigger* differs (inside `/end-cps` rather than `/epilogue`), which is unavoidable and contained to one server method.

---

### Task 6: Client — multiplayer (socket) screens reuse and wiring

**Files:**
- Modify: `client/src/hooks/useMultiplayer.ts` (advance via `E.READY` in the new phases; expose `interventionText` from `ViewerState`)
- Modify: `client/src/components/MultiplayerGame.tsx` (add dispatch branches near the `debrief` block at ~379, rendering the SAME three screen components from Task 5)

**Interfaces:** multiplayer advances through interventions with the existing ready mechanic (`mp.ready(true)`), because the server's READY handler now branches on the new phases (Task 4). Both players ready-up to advance, consistent with debrief. The screens are shared with solo (Task 5) — render them with `text={mp.state.interventionText ?? ""}` and `onContinue`/ready wired to `mp.ready(true)` (or a `ReadyToggle` like the debrief block for the two-player case).

- [ ] **Step 1** Add the three dispatch branches to `MultiplayerGame` reusing `ConsultScreen`/`TherapyScreen`/`CpsScreen`. For the two-player interventions, mirror the debrief block's `ReadyToggle` pattern so both players advance. **Step 2** Ensure `interventionText` is read from `mp.state` (it's on `ViewerState` per Task 4 Step 4). **Step 3** `npm run build -w client` succeeds. **Step 4 Commit** `feat(ladder): multiplayer client intervention screens + wiring`.

---

### Task 7: End-to-end verification pass + spec self-check

- [ ] Run `npm run test -w server` (all gated tests pass), `npx tsc -b server` (0), `npm run build -w client` (succeeds).
- [ ] Manually trace both transports for each rung and for the removal branch against §6/§7/§8; confirm no path calls `applyModerationBlock`/`banIp` (grep the diff), and that `concernLevel`/`highestRungFired`/`cpsOutcome` never appear in a client payload except `interventionText`.
- [ ] Commit any fixes; the whole-branch reviewer runs after this.

## Deploy (after review)

- [ ] Merge to `main`, push, `ssh games 'cd /opt/raising-intelligences && ./deploy.sh'` (migration 016 auto-applies; test gate must pass).
- [ ] Verify columns `highest_rung_fired`/`cps_outcome` exist; health 200; a smoke playthrough that pushes concern to Rung 1 shows the consult screen in a browser (per [[verify-live-games]] / [[use-subagents]] — verify in an actual browser, both solo and multiplayer).

## Self-Review (author checklist — completed)

- **Spec coverage:** §6 Rung 1/2/3 (consult, therapy, deliberated CPS with the four framework criteria in the prompt) ✅; §6 removal = terminal epilogue branch, not a ban ✅ (Global Constraints + Task 4 removal path); §7 repair decays concern on engagement ✅ (completion decays); §8 removal decoupled from ban path ✅ (explicit grep in Task 7). Report-card/epilogue reflecting accumulated concern is largely existing behavior; the removal epilogue is the one new branch.
- **Open questions (§12) resolved with documented defaults:** thresholds 3/6/9, decays 2/3/4, rung-1-folds-into-a-new-phase (not the debrief), escalation window is Plan 4's not this plan's, removal terminal. All tunable constants in one place.
- **Placeholder scan:** Tasks 3/5/6 compress repetitive per-transport steps but every logic decision (the routing rule, the CPS defensive parse, the removal branch, the decay values) is fully specified; the React screens mirror an existing component whose full source is the template. No "add error handling"-class placeholders.
- **Type consistency:** `selectDueRung`, `ENTER_INTERVENTION/SET_CPS_OUTCOME/END_INTERVENTION`, the three roles, and `interventionText`/`highestRungFired`/`cpsOutcome` are named identically across all tasks.
- **The one scope decision for reviewer/Liz:** intervention phases are read-and-advance, not interactive; therapy engagement = completion. Flagged in Global Constraints.
- **Deliberate v1 limitation (accepted, not an omission):** the ladder is single-shot — once Rung 3 (CPS) fires with a `stay`/`safety_plan` outcome, `highestRungFired` pins at 3 and no further rung can fire even if the parent keeps escalating (concern just pins at `CONCERN_MAX`). Real child welfare would return a failed safety plan to review→removal; that re-review loop is deferred. The bad-faith backstop for continued escalation is Plan 4 (escalation detection). Decided deliberately for v1.
- **Removal-epilogue delivery pinned:** generated inside `/end-cps`, delivered via the existing epilogue-display path (Task 5 Step 3a) — no second epilogue code path.
- **Correctness guard verified against source:** `START_EPILOGUE`'s `canTransition` guard (state-machine.ts:106) is `event_intro || debrief` today; Task 1 widens it to include `cps_review`, and the Task 3 removal test starts from `cps_review` to prove it.
