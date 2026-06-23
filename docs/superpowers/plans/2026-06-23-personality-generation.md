# Personality Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the random temperament system with an OCEAN personality quiz that parents take during the guardian screen, producing a personality seed that drives the AI kid's behavior throughout the game.

**Architecture:** Parents answer 5 multiple-choice OCEAN questions + 2 confessional essays during the guardian screen. Scores combine server-side via genetic lottery (with wild cards for disagreements), then an LLM generates a personality seed document that replaces the old random `temperament` field. Confessionals also feed "landmine" events to the World Manager. The guardian screen's child thought fragments become personality-tagged, shifting to match quiz answers in real-time.

**Tech Stack:** TypeScript, React, Express, Socket.IO, PostgreSQL, Vitest

## Global Constraints

- The `temperament` field on `GameState` is renamed to `personalitySeed` everywhere — no parallel fields
- Parent personality data (OCEAN scores + confessionals) is never exposed to the other parent via API or socket
- Confessional prompts are optional — empty strings are valid
- OCEAN scores are integers 1-4 per trait, stored as a 5-element array `[O, C, E, A, N]`
- The personality seed replaces the random temperament in all 4 prompt systems and the context assembler
- New DB migration is required — the old `temperament` was never persisted (existing bug)

---

### Task 1: Data Model — Types, State Machine, and DB Migration

**Files:**
- Modify: `server/src/types.ts:35-52`
- Modify: `server/src/game/state-machine.ts:1-56`
- Create: `server/src/db/migrations/007-personality.sql`
- Modify: `server/src/db/repository.ts:51-101` (reconstructState)
- Modify: `server/src/db/repository.ts:106-137` (PgGameRepository.saveGame)
- Modify: `server/src/db/repository.ts:232-330` (PgGameRepository.loadGame)
- Modify: `server/src/db/repository.ts:337-448` (InMemoryGameRepository)
- Test: `server/tests/state-machine.test.ts`

**Interfaces:**
- Produces: `ParentPersonality` type, updated `GameState` with `personalitySeed` and `parentPersonalities` fields, `combineTraits(parent1, parent2?)` function, `PERSONALITY_SEED_PROMPT` template

- [ ] **Step 1: Write failing test for updated createGame**

In `server/tests/state-machine.test.ts`, update the existing test and add new ones:

```typescript
describe("createGame", () => {
  it("creates a game with empty personalitySeed and no parentPersonalities", () => {
    const state = createGame("Luna");
    expect(state.childName).toBe("Luna");
    expect(state.phase).toBe("event_intro");
    expect(state.personalitySeed).toBe("");
    expect(state.parentPersonalities).toEqual({});
    // temperament field should no longer exist
    expect("temperament" in state).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/state-machine.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `state.personalitySeed` is undefined, `state.temperament` still exists

- [ ] **Step 3: Update types.ts — replace temperament with personality fields**

In `server/src/types.ts`, replace the `temperament` field and add new types:

```typescript
export interface ParentPersonality {
  ocean: [number, number, number, number, number]; // [O, C, E, A, N], each 1-4
  confessional1: string;
  confessional2: string;
}

export interface GameState {
  id: string;
  phase: GamePhase;
  childName: string;
  relationshipType: string;
  personalitySeed: string;
  parentPersonalities: {
    parent1?: ParentPersonality;
    parent2?: ParentPersonality;
  };
  currentEvent: GameEvent | null;
  currentEventNumber: number;
  totalEvents: number;
  identityDocument: string;
  identitySnapshots: { eventNumber: number; document: string }[];
  events: GameEvent[];
  messages: Message[];
  parentMessageCount: number;
  sidebarUsed: { parent1: boolean; parent2: boolean };
  sidebarActive: Sender | null;
  lastActivityAt: number;
}
```

- [ ] **Step 4: Update state-machine.ts — remove TEMPERAMENTS, update createGame**

Remove the `TEMPERAMENTS` array (lines 6-15) and `getRandomTemperament()` function (lines 17-19). Update `createGame()`:

```typescript
export function createGame(childName: string, relationshipType = "co-parents"): GameState {
  return {
    id: randomUUID(),
    phase: "event_intro",
    childName,
    relationshipType,
    personalitySeed: "",
    parentPersonalities: {},
    currentEvent: null,
    currentEventNumber: 0,
    totalEvents: 10,
    identityDocument: "",
    identitySnapshots: [],
    events: [],
    messages: [],
    parentMessageCount: 0,
    sidebarUsed: { parent1: false, parent2: false },
    sidebarActive: null,
    lastActivityAt: Date.now(),
  };
}
```

- [ ] **Step 5: Update repository.ts — reconstructState, saveGame, loadGame**

In `reconstructState`, replace `temperament` with `personalitySeed` and add `parentPersonalities`:

```typescript
function reconstructState(input: {
  id: string;
  phase: GamePhase;
  childName: string;
  relationshipType: string;
  personalitySeed?: string;
  parentPersonalities?: { parent1?: ParentPersonality; parent2?: ParentPersonality };
  currentEventNumber: number;
  totalEvents: number;
  identityDocument: string;
  events: GameEvent[];
  messages: Message[];
  identitySnapshots: IdentitySnapshot[];
  sidebarUsed: { parent1: boolean; parent2: boolean };
  sidebarActive?: string | null;
}): GameState {
  // ... existing currentEvent and parentMessageCount logic unchanged ...

  return {
    id: input.id,
    phase: input.phase,
    childName: input.childName,
    relationshipType: input.relationshipType,
    personalitySeed: input.personalitySeed ?? "",
    parentPersonalities: input.parentPersonalities ?? {},
    currentEvent,
    currentEventNumber: input.currentEventNumber,
    totalEvents: input.totalEvents,
    identityDocument: input.identityDocument,
    identitySnapshots: input.identitySnapshots,
    events: input.events,
    messages: input.messages,
    parentMessageCount,
    sidebarUsed: input.sidebarUsed,
    sidebarActive: (input.sidebarActive as GameState["sidebarActive"]) ?? null,
    lastActivityAt: Date.now(),
  };
}
```

Add the `ParentPersonality` import at the top of repository.ts:

```typescript
import type {
  GameEvent,
  GamePhase,
  GameState,
  Message,
  ParentPersonality,
  Sender,
} from "../types.js";
```

In `PgGameRepository.saveGame`, add `personality_seed` and `parent_personalities` columns:

```typescript
async saveGame(state: GameState): Promise<void> {
  await this.db.query(
    `INSERT INTO games
       (id, child_name, relationship_type, phase, current_event_number,
        total_events, identity_document, personality_seed, parent_personalities,
        sidebar_used_parent1, sidebar_used_parent2, sidebar_active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, now())
     ON CONFLICT (id) DO UPDATE SET
       child_name            = EXCLUDED.child_name,
       relationship_type     = EXCLUDED.relationship_type,
       phase                 = EXCLUDED.phase,
       current_event_number  = EXCLUDED.current_event_number,
       total_events          = EXCLUDED.total_events,
       identity_document     = EXCLUDED.identity_document,
       personality_seed      = EXCLUDED.personality_seed,
       parent_personalities  = EXCLUDED.parent_personalities,
       sidebar_used_parent1  = EXCLUDED.sidebar_used_parent1,
       sidebar_used_parent2  = EXCLUDED.sidebar_used_parent2,
       sidebar_active        = EXCLUDED.sidebar_active,
       updated_at            = now()`,
    [
      state.id,
      state.childName,
      state.relationshipType,
      state.phase,
      state.currentEventNumber,
      state.totalEvents,
      state.identityDocument,
      state.personalitySeed,
      JSON.stringify(state.parentPersonalities),
      state.sidebarUsed.parent1,
      state.sidebarUsed.parent2,
      state.sidebarActive ?? null,
    ]
  );
}
```

In `PgGameRepository.loadGame`, add the new columns to the SELECT and pass them to `reconstructState`:

```typescript
const gameRes = await this.db.query<{
  id: string;
  child_name: string;
  relationship_type: string;
  phase: GamePhase;
  current_event_number: number;
  total_events: number;
  identity_document: string;
  personality_seed: string;
  parent_personalities: { parent1?: ParentPersonality; parent2?: ParentPersonality } | null;
  sidebar_used_parent1: boolean;
  sidebar_used_parent2: boolean;
  sidebar_active: string | null;
}>(
  `SELECT id, child_name, relationship_type, phase,
          current_event_number, total_events, identity_document,
          COALESCE(personality_seed, '') AS personality_seed,
          parent_personalities,
          COALESCE(sidebar_used_parent1, false) AS sidebar_used_parent1,
          COALESCE(sidebar_used_parent2, false) AS sidebar_used_parent2,
          sidebar_active
   FROM games WHERE id = $1`,
  [gameId]
);
```

And in the `reconstructState` call:

```typescript
return reconstructState({
  id: game.id,
  phase: game.phase,
  childName: game.child_name,
  relationshipType: game.relationship_type,
  personalitySeed: game.personality_seed,
  parentPersonalities: game.parent_personalities ?? {},
  currentEventNumber: game.current_event_number,
  // ... rest unchanged
});
```

Update `InMemoryGameRepository` similarly — replace `temperament` with `personalitySeed` and `parentPersonalities` in the stored type, `saveGame`, and `loadGame`.

- [ ] **Step 6: Create DB migration**

Create `server/src/db/migrations/007-personality.sql`:

```sql
ALTER TABLE games ADD COLUMN IF NOT EXISTS personality_seed TEXT NOT NULL DEFAULT '';
ALTER TABLE games ADD COLUMN IF NOT EXISTS parent_personalities JSONB NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 7: Run tests to verify everything compiles and passes**

Run: `cd server && npx vitest run tests/state-machine.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 8: Fix any remaining references to `temperament` in test files**

Run: `grep -rn "temperament" server/tests/ server/src/`
Fix any remaining references — they should all now use `personalitySeed`.

- [ ] **Step 9: Run full test suite to catch breakage**

Run: `cd server && npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All tests pass (some may need `temperament` → `personalitySeed` updates)

- [ ] **Step 10: Commit**

```bash
git add server/src/types.ts server/src/game/state-machine.ts server/src/db/repository.ts server/src/db/migrations/007-personality.sql server/tests/
git commit -m "feat: replace temperament with personalitySeed and parentPersonalities

Remove random TEMPERAMENTS array. Add ParentPersonality type with
OCEAN scores and confessionals. Persist personality_seed and
parent_personalities to database (fixes existing persistence bug).
"
```

---

### Task 2: Trait Combination Algorithm

**Files:**
- Create: `server/src/game/personality.ts`
- Test: `server/tests/personality.test.ts`

**Interfaces:**
- Consumes: `ParentPersonality` from `types.ts`
- Produces: `combineTraits(parent1: [number,number,number,number,number], parent2?: [number,number,number,number,number]): [number,number,number,number,number]`

- [ ] **Step 1: Write failing tests for trait combination**

Create `server/tests/personality.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { combineTraits } from "../src/game/personality.js";

describe("combineTraits", () => {
  it("single parent: returns parent scores with variance on exactly 2 traits", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.0)  // pick trait index 0
      .mockReturnValueOnce(0.25) // pick trait index 1
      .mockReturnValueOnce(0.1)  // shift direction for trait 0: +1
      .mockReturnValueOnce(0.9); // shift direction for trait 1: -1

    const parent: [number, number, number, number, number] = [2, 3, 2, 3, 2];
    const result = combineTraits(parent);
    // Trait 0: 2+1=3, Trait 1: 3-1=2, rest unchanged
    expect(result).toEqual([3, 2, 2, 3, 2]);

    vi.restoreAllMocks();
  });

  it("single parent: clamps scores to 1-4", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.0)  // pick trait index 0
      .mockReturnValueOnce(0.25) // pick trait index 1
      .mockReturnValueOnce(0.9)  // shift direction for trait 0: -1
      .mockReturnValueOnce(0.1); // shift direction for trait 1: +1

    const parent: [number, number, number, number, number] = [1, 4, 2, 3, 2];
    const result = combineTraits(parent);
    // Trait 0: max(1, 1-1)=1 clamped, Trait 1: min(4, 4+1)=4 clamped
    expect(result[0]).toBeGreaterThanOrEqual(1);
    expect(result[1]).toBeLessThanOrEqual(4);

    vi.restoreAllMocks();
  });

  it("two parents agreeing (diff<=1): picks one parent's score per trait", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.3)  // trait 0: pick parent1
      .mockReturnValueOnce(0.7)  // trait 1: pick parent2
      .mockReturnValueOnce(0.3)  // trait 2: pick parent1
      .mockReturnValueOnce(0.7)  // trait 3: pick parent2
      .mockReturnValueOnce(0.3); // trait 4: pick parent1

    const p1: [number, number, number, number, number] = [3, 2, 3, 2, 3];
    const p2: [number, number, number, number, number] = [3, 3, 3, 3, 3];
    const result = combineTraits(p1, p2);
    // diff all <=1, so genetic lottery: parent1 for 0,2,4; parent2 for 1,3
    expect(result).toEqual([3, 3, 3, 3, 3]);

    vi.restoreAllMocks();
  });

  it("two parents disagreeing (diff>=2): wild card for that trait", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.5)  // trait 0: wild card (diff=3) → floor(0.5*4)+1=3
      .mockReturnValueOnce(0.3)  // trait 1: pick parent1 (diff=0)
      .mockReturnValueOnce(0.7)  // trait 2: pick parent2 (diff=1)
      .mockReturnValueOnce(0.0)  // trait 3: wild card (diff=2) → floor(0.0*4)+1=1
      .mockReturnValueOnce(0.3); // trait 4: pick parent1 (diff=0)

    const p1: [number, number, number, number, number] = [1, 2, 3, 1, 3];
    const p2: [number, number, number, number, number] = [4, 2, 2, 3, 3];
    const result = combineTraits(p1, p2);
    expect(result).toEqual([3, 2, 2, 1, 3]);

    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/personality.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement combineTraits**

Create `server/src/game/personality.ts`:

```typescript
type OceanScores = [number, number, number, number, number];

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function combineTraits(parent1: OceanScores, parent2?: OceanScores): OceanScores {
  if (!parent2) {
    const result = [...parent1] as OceanScores;
    const indices = [0, 1, 2, 3, 4];
    // Pick 2 random traits to apply variance
    const idx1 = indices.splice(Math.floor(Math.random() * indices.length), 1)[0];
    const idx2 = indices.splice(Math.floor(Math.random() * indices.length), 1)[0];
    for (const idx of [idx1, idx2]) {
      const shift = Math.random() < 0.5 ? 1 : -1;
      result[idx] = clamp(result[idx] + shift, 1, 4);
    }
    return result;
  }

  const result: number[] = [];
  for (let i = 0; i < 5; i++) {
    const diff = Math.abs(parent1[i] - parent2[i]);
    if (diff >= 2) {
      result.push(Math.floor(Math.random() * 4) + 1);
    } else {
      result.push(Math.random() < 0.5 ? parent1[i] : parent2[i]);
    }
  }
  return result as OceanScores;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/personality.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/game/personality.ts server/tests/personality.test.ts
git commit -m "feat: trait combination algorithm (genetic lottery + wild cards)"
```

---

### Task 3: Personality Seed Generation Prompt and LLM Integration

**Files:**
- Modify: `server/src/game/personality.ts`
- Modify: `server/src/llm/prompts.ts`
- Modify: `server/src/llm/model-config.ts:17-24`
- Test: `server/tests/personality.test.ts`

**Interfaces:**
- Consumes: `combineTraits` from Task 2, `LLMClient` from `llm/client.ts`, `ParentPersonality` from `types.ts`
- Produces: `generatePersonalitySeed(llm, childName, parent1, parent2?): Promise<string>`, `PERSONALITY_SEED_SYSTEM_PROMPT` constant

- [ ] **Step 1: Write failing test for seed generation**

Add to `server/tests/personality.test.ts`:

```typescript
import { generatePersonalitySeed } from "../src/game/personality.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { ParentPersonality } from "../src/types.js";

describe("generatePersonalitySeed", () => {
  it("calls LLM with OCEAN scores and confessionals, returns seed text", async () => {
    const llm = new MockLLMClient();
    const seedText = "A curious kid who watches more than they speak.";
    llm.identityUpdates = [seedText];

    const parent1: ParentPersonality = {
      ocean: [3, 2, 1, 4, 3],
      confessional1: "I stole candy from the store",
      confessional2: "I cheated on a test",
    };

    const result = await generatePersonalitySeed(llm, "Luna", parent1);
    expect(result).toBe(seedText);
    expect(llm.roleCalls).toContain("personality_seed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/personality.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `generatePersonalitySeed` not exported

- [ ] **Step 3: Add personality_seed LLM role**

In `server/src/llm/model-config.ts`, add `"personality_seed"` to the `LLMRole` type:

```typescript
export type LLMRole =
  | "kid_family_chat"
  | "kid_sidebar"
  | "kid_adult_chat"
  | "world_manager"
  | "psychologist"
  | "epilogue"
  | "report_card"
  | "personality_seed";
```

Add the role to each model tier config — use the same model as `psychologist` since it's a one-time quality-critical call:

```typescript
export const STANDARD_MODELS: ModelConfig = {
  // ... existing entries ...
  personality_seed: "qwen/qwen3.7-max",
};
export const CEREBRAS_MODELS: ModelConfig = {
  // ... existing entries ...
  personality_seed: "cerebras:gpt-oss-120b",
};
export const PREMIUM_MODELS: ModelConfig = {
  // ... existing entries ...
  personality_seed: "google/gemini-2.5-flash",
};
```

- [ ] **Step 4: Add PERSONALITY_SEED_SYSTEM_PROMPT to prompts.ts**

Add to `server/src/llm/prompts.ts`:

```typescript
export const PERSONALITY_SEED_SYSTEM_PROMPT = `You are generating the innate personality of a 3-year-old child named {childName}.

You have been given their Big Five (OCEAN) personality scores on a 1-4 scale and emotional themes from their parent(s)' childhood confessionals.

Write a personality seed document — a 150-200 word description of who this child IS at their core, written in the child's internal voice (appropriate for a 3-year-old's inner world — simple, sensory, emotional).

The document should cover:
- **Innate temperament** — how this child naturally responds to the world. Map directly from the OCEAN scores:
  - Openness: curiosity, imagination, willingness to try new things
  - Conscientiousness: persistence, rule-following, self-control
  - Extraversion: energy around people, boldness, need for stimulation
  - Agreeableness: cooperation, empathy, compliance vs. defiance
  - Neuroticism: emotional reactivity, anxiety, sensitivity to stress
- **Echoes** — subtle tendencies that rhyme with the parents' emotional themes. Don't copy specific acts — capture the underlying emotional pattern (shame, rebellion, secrecy, curiosity about forbidden things, etc.) as a faint tendency in the child

This is who the child is BEFORE parenting shapes them. Nature, not nurture. Parenting will reinforce, redirect, or work against these tendencies — but they are the substrate.

Do NOT use clinical language. Write as if describing a child's inner weather — what they reach for, what makes them flinch, what they notice that others don't.

Output ONLY the personality seed document. No preamble, no commentary.`;
```

- [ ] **Step 5: Implement generatePersonalitySeed**

Add to `server/src/game/personality.ts`:

```typescript
import type { LLMClient } from "../llm/client.js";
import type { ParentPersonality } from "../types.js";
import { PERSONALITY_SEED_SYSTEM_PROMPT } from "../llm/prompts.js";

const OCEAN_LABELS = ["Openness", "Conscientiousness", "Extraversion", "Agreeableness", "Neuroticism"];

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

export async function generatePersonalitySeed(
  llm: LLMClient,
  childName: string,
  parent1: ParentPersonality,
  parent2?: ParentPersonality,
): Promise<string> {
  const kidScores = combineTraits(parent1.ocean, parent2?.ocean);

  const scoresText = OCEAN_LABELS
    .map((label, i) => `- ${label}: ${kidScores[i]}/4`)
    .join("\n");

  let confessionalText = `Parent 1's emotional themes:\n- "${parent1.confessional1}"\n- "${parent1.confessional2}"`;
  if (parent2) {
    confessionalText += `\n\nParent 2's emotional themes:\n- "${parent2.confessional1}"\n- "${parent2.confessional2}"`;
  }

  const system = fillTemplate(PERSONALITY_SEED_SYSTEM_PROMPT, { childName });
  const userMessage = `OCEAN scores for ${childName}:\n${scoresText}\n\n${confessionalText}`;

  return llm.completeResponse(system, userMessage, undefined, "personality_seed");
}
```

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run tests/personality.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/game/personality.ts server/src/llm/prompts.ts server/src/llm/model-config.ts server/tests/personality.test.ts
git commit -m "feat: personality seed LLM generation from OCEAN scores + confessionals"
```

---

### Task 4: Prompt System Updates — Replace Temperament References

**Files:**
- Modify: `server/src/llm/prompts.ts` (KID_SYSTEM_PROMPT, PSYCHOLOGIST_SYSTEM_PROMPT, WORLD_MANAGER_SYSTEM_PROMPT, EPILOGUE_SYSTEM_PROMPT)
- Modify: `server/src/game/context-assembler.ts:105-111,174-196`
- Test: `server/tests/context-assembler.test.ts`

**Interfaces:**
- Consumes: `GameState.personalitySeed`, `GameState.parentPersonalities` from Task 1
- Produces: Updated prompt templates with `{personalitySeed}` slots, landmine injection in World Manager context

- [ ] **Step 1: Write failing test for context assembler using personalitySeed**

Add to `server/tests/context-assembler.test.ts`:

```typescript
it("buildKidContext uses personalitySeed instead of temperament", () => {
  const state = createGame("Luna");
  state.personalitySeed = "Curious and bold. Reaches for everything.";
  state.currentEvent = testEvent;
  const { system } = buildKidContext(state);
  expect(system).toContain("Curious and bold. Reaches for everything.");
  expect(system).not.toContain("{personalitySeed}");
});

it("buildWorldManagerContext includes personalitySeed", () => {
  const state = createGame("Luna");
  state.personalitySeed = "Curious and bold.";
  const { system } = buildWorldManagerContext(state);
  expect(system).toContain("Curious and bold.");
});

it("buildWorldManagerContext includes confessional landmines when present", () => {
  const state = createGame("Luna");
  state.personalitySeed = "Curious and bold.";
  state.parentPersonalities = {
    parent1: {
      ocean: [3, 2, 1, 4, 3],
      confessional1: "I stole candy from the store",
      confessional2: "I cheated on a test",
    },
  };
  const { system } = buildWorldManagerContext(state);
  expect(system).toContain("I stole candy from the store");
  expect(system).toContain("Hidden material");
});

it("buildWorldManagerContext omits landmine section when no confessionals", () => {
  const state = createGame("Luna");
  state.personalitySeed = "Curious and bold.";
  state.parentPersonalities = {
    parent1: { ocean: [3, 2, 1, 4, 3], confessional1: "", confessional2: "" },
  };
  const { system } = buildWorldManagerContext(state);
  expect(system).not.toContain("Hidden material");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/context-assembler.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `personalitySeed` not recognized in template

- [ ] **Step 3: Update KID_SYSTEM_PROMPT**

In `server/src/llm/prompts.ts`, replace all `{temperament}` references with `{personalitySeed}`:

Find `Your temperament: {temperament}` and the surrounding temperament instructions, replace with:

```
Your temperament: {personalitySeed}

This is who you are. It doesn't change based on what your parents do. They can do everything right and you can still be difficult. They can do everything wrong and you can still be sweet sometimes. That's just how kids work.
```

Keep the existing language about not being sweet just because the parent did something good — just ensure it references `personalitySeed` instead of `temperament`.

- [ ] **Step 4: Update WORLD_MANAGER_SYSTEM_PROMPT**

Replace `{childTemperament}` with `{personalitySeed}` in the child temperament section. Also add a `{landmineSection}` template slot:

```
## Child temperament

{personalitySeed}

The child's temperament should influence what events happen and how they play out.

{landmineSection}
```

- [ ] **Step 5: Update PSYCHOLOGIST_SYSTEM_PROMPT**

Add innate temperament instructions to the psychologist prompt. After the existing guidelines, add:

```
The child has an innate temperament (provided in the conversation context). This is their baseline — nature, not nurture. Your Identity Document should reflect how parenting is interacting with these innate tendencies:
- Are the parents reinforcing a natural tendency? Note it becoming stronger.
- Are they working against one? Note the tension — the tendency doesn't vanish, it goes underground or creates friction.
- Are they ignoring one? Note it expressing itself in unguided ways.
```

- [ ] **Step 6: Update EPILOGUE_SYSTEM_PROMPT**

Replace `{temperament}` references with `{personalitySeed}` if present. The existing epilogue prompt may not explicitly reference temperament as a template variable — check and update if needed.

- [ ] **Step 7: Update context-assembler.ts — buildKidContext**

In `buildKidContext` (around line 105-111), replace `temperament: state.temperament` with `personalitySeed: state.personalitySeed`:

```typescript
const system = fillTemplate(KID_SYSTEM_PROMPT, {
  childName: state.childName,
  age: String(state.currentEvent?.age ?? 4),
  personalitySeed: state.personalitySeed,
  identitySection,
  eventDescription: state.currentEvent?.description ?? "",
});
```

- [ ] **Step 8: Update context-assembler.ts — buildWorldManagerContext**

Replace `childTemperament: state.temperament` with `personalitySeed: state.personalitySeed` and add landmine section construction:

```typescript
export function buildWorldManagerContext(state: GameState): {
  system: string;
  userMessage: string;
} {
  const previousEvents =
    state.events.length > 0
      ? state.events.map((e) => `- Age ${e.age}: ${e.description}`).join("\n")
      : "No events yet — this is the beginning of the story.";

  let landmineSection = "";
  const pp = state.parentPersonalities;
  const hasConfessionals = (p?: { confessional1: string; confessional2: string }) =>
    p && (p.confessional1.trim() || p.confessional2.trim());

  if (hasConfessionals(pp.parent1) || hasConfessionals(pp.parent2)) {
    landmineSection = `\n## Hidden material (DO NOT reference directly — use as thematic inspiration for 2-3 events across the arc)\n\nThese are things the parent(s) experienced or hid during their own childhood. Create events where the child faces thematically similar situations — not copies, but rhymes. The parents should feel a chill of recognition without the game explicitly calling it out.\n\nSpread these across the 10-event arc (roughly events 3-4, 6-7, and 9-10) rather than front-loading them.\n`;
    if (hasConfessionals(pp.parent1)) {
      landmineSection += `\nParent 1's childhood:\n`;
      if (pp.parent1!.confessional1.trim()) landmineSection += `- ${pp.parent1!.confessional1}\n`;
      if (pp.parent1!.confessional2.trim()) landmineSection += `- ${pp.parent1!.confessional2}\n`;
    }
    if (hasConfessionals(pp.parent2)) {
      landmineSection += `\nParent 2's childhood:\n`;
      if (pp.parent2!.confessional1.trim()) landmineSection += `- ${pp.parent2!.confessional1}\n`;
      if (pp.parent2!.confessional2.trim()) landmineSection += `- ${pp.parent2!.confessional2}\n`;
    }
  }

  const system = fillTemplate(WORLD_MANAGER_SYSTEM_PROMPT, {
    childName: state.childName,
    personalitySeed: state.personalitySeed,
    previousEvents,
    familyStructure: familyStructureText(state.relationshipType),
    landmineSection,
  });

  let userMessage = `Generate the next event (event #${state.currentEventNumber + 1}).`;
  if (state.identityDocument) {
    userMessage += `\n\nCurrent Identity Document:\n${state.identityDocument}`;
  }

  return { system, userMessage };
}
```

- [ ] **Step 9: Run context assembler tests**

Run: `cd server && npx vitest run tests/context-assembler.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All PASS

- [ ] **Step 10: Run full test suite**

Run: `cd server && npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All tests pass. Fix any remaining `temperament` references.

- [ ] **Step 11: Commit**

```bash
git add server/src/llm/prompts.ts server/src/game/context-assembler.ts server/tests/context-assembler.test.ts
git commit -m "feat: replace temperament with personalitySeed in all prompts

Update KID, PSYCHOLOGIST, WORLD_MANAGER, and EPILOGUE prompts.
Add landmine section to World Manager for confessional integration.
Add nature-vs-nurture tracking to Psychologist instructions.
"
```

---

### Task 5: API Endpoint and Socket Events for Personality Submission

**Files:**
- Modify: `server/src/routes/game.ts`
- Modify: `server/src/socket/protocol.ts`
- Modify: `server/src/socket/handlers.ts`
- Test: `server/tests/personality.test.ts` (add API-level tests)

**Interfaces:**
- Consumes: `generatePersonalitySeed` from Task 3, `GameState.parentPersonalities` from Task 1
- Produces: `POST /api/game/:id/personality` endpoint, `PERSONALITY_SUBMITTED` and `PERSONALITY_SEED_READY` socket events

- [ ] **Step 1: Add socket event constants**

In `server/src/socket/protocol.ts`, add the new payload type and events:

```typescript
export interface PersonalityPayload {
  ocean: [number, number, number, number, number];
  confessional1?: string;
  confessional2?: string;
}
```

Add to `SOCKET_EVENTS`:

```typescript
export const SOCKET_EVENTS = {
  // client → server
  CREATE_GAME: "create_game",
  JOIN_GAME: "join_game",
  READY: "ready",
  PARENT_MESSAGE: "parent_message",
  START_SIDEBAR: "start_sidebar",
  END_SIDEBAR: "end_sidebar",
  END_CHAT: "end_chat",
  START_EPILOGUE: "start_epilogue",
  ADULT_CHAT: "adult_chat",
  REPORT_CARD: "report_card",
  SUBMIT_PERSONALITY: "submit_personality",
  // server → client
  JOINED: "joined",
  LOBBY: "lobby",
  STATE: "state",
  KID_CHUNK: "kid_chunk",
  MESSAGE_DONE: "message_done",
  DOC_CHUNK: "doc_chunk",
  DOC_DONE: "doc_done",
  EPILOGUE: "epilogue",
  REPORT_CARD_READY: "report_card_ready",
  PERSONALITY_SUBMITTED: "personality_submitted",
  PERSONALITY_SEED_READY: "personality_seed_ready",
  ERROR: "error",
} as const;
```

- [ ] **Step 2: Add REST endpoint for solo personality submission**

In `server/src/routes/game.ts`, add the personality endpoint after the game creation route. Add imports at the top:

```typescript
import { generatePersonalitySeed } from "../game/personality.js";
import type { ParentPersonality } from "../types.js";
```

Add the route:

```typescript
router.post("/game/:id/personality", async (req: Request, res: Response) => {
  const { ocean, confessional1, confessional2 } = req.body as {
    ocean: [number, number, number, number, number];
    confessional1?: string;
    confessional2?: string;
  };

  if (!Array.isArray(ocean) || ocean.length !== 5 || ocean.some((s) => s < 1 || s > 4 || !Number.isInteger(s))) {
    res.status(400).json({ error: "ocean must be an array of 5 integers, each 1-4" });
    return;
  }

  const state = await resolveGame(req.params.id as string);
  if (!state) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const personality: ParentPersonality = {
    ocean,
    confessional1: (confessional1 ?? "").slice(0, 500),
    confessional2: (confessional2 ?? "").slice(0, 500),
  };

  state.parentPersonalities = { ...state.parentPersonalities, parent1: personality };

  // Solo mode: generate seed immediately
  const seed = await generatePersonalitySeed(engine.llm, state.childName, personality);
  state.personalitySeed = seed;
  games.set(state.id, state);
  await repo.saveGame(state);

  res.json({ ready: true });
});
```

Note: We need to expose the `llm` client from `ConversationEngine`. Add a public getter or pass it directly. The simplest approach: add `get llm()` to ConversationEngine or pass the LLMClient to `createGameRoutes`. Let's add a field:

In `server/src/game/conversation-engine.ts`, make the `llm` field accessible:

```typescript
export class ConversationEngine {
  constructor(public readonly llm: LLMClient) {}
  // ... rest unchanged
}
```

(Change `private llm` to `public readonly llm` — one word change on line 19.)

- [ ] **Step 3: Add socket handler for multiplayer personality submission**

In `server/src/socket/handlers.ts`, add the import and handler. Add to imports:

```typescript
import { generatePersonalitySeed } from "../game/personality.js";
import type { PersonalityPayload } from "./protocol.js";
```

Add the handler inside `registerSocketHandlers`, after the READY handler:

```typescript
// ---- SUBMIT_PERSONALITY ----
socket.on(E.SUBMIT_PERSONALITY, async (payload: PersonalityPayload) => {
  const gameId = data.gameId;
  const slot = data.slot;
  const state = currentState();
  if (!gameId || !slot || slot === "kid" || !state) return fail("Not in a game");

  if (!Array.isArray(payload?.ocean) || payload.ocean.length !== 5 ||
      payload.ocean.some((s) => s < 1 || s > 4 || !Number.isInteger(s))) {
    return fail("ocean must be an array of 5 integers, each 1-4");
  }

  const personality: ParentPersonality = {
    ocean: payload.ocean,
    confessional1: (payload.confessional1 ?? "").slice(0, 500),
    confessional2: (payload.confessional2 ?? "").slice(0, 500),
  };

  state.parentPersonalities = { ...state.parentPersonalities, [slot]: personality };
  games.set(gameId, state);
  await repo.saveGame(state);

  io.to(gameId).emit(E.PERSONALITY_SUBMITTED, { slot });

  // Check if all required parents have submitted
  const isSolo = state.relationshipType === "solo parent" || state.relationshipType === "solo";
  const session = sessions.get(gameId);
  const allSubmitted = isSolo
    ? !!state.parentPersonalities.parent1
    : !!state.parentPersonalities.parent1 && !!state.parentPersonalities.parent2;

  if (allSubmitted) {
    const seed = await generatePersonalitySeed(
      deps.conversationEngine.llm,
      state.childName,
      state.parentPersonalities.parent1!,
      state.parentPersonalities.parent2,
    );
    state.personalitySeed = seed;
    games.set(gameId, state);
    await repo.saveGame(state);
    io.to(gameId).emit(E.PERSONALITY_SEED_READY, {});
  }
});
```

Add the `ParentPersonality` import to the handlers file:

```typescript
import type { GameState, ParentPersonality, Sender } from "../types.js";
```

- [ ] **Step 4: Run full test suite**

Run: `cd server && npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/game.ts server/src/socket/protocol.ts server/src/socket/handlers.ts server/src/game/conversation-engine.ts
git commit -m "feat: personality submission API endpoint and socket events

POST /api/game/:id/personality for solo games.
SUBMIT_PERSONALITY socket event for multiplayer.
Generates personality seed when all required parents submit.
Broadcasts PERSONALITY_SUBMITTED and PERSONALITY_SEED_READY events.
"
```

---

### Task 6: Guardian Screen Quiz UI — OCEAN Questions Interspersed with Intro

**Files:**
- Create: `client/src/components/PersonalityQuiz.tsx`
- Create: `client/src/data/ocean-questions.ts`
- Create: `client/src/data/child-fragments.ts`
- Modify: `client/src/components/GuardianScreen.tsx`
- Modify: `client/src/hooks/useGame.ts`
- Modify: `client/src/hooks/useMultiplayer.ts`
- Modify: `client/src/components/SoloGame.tsx`
- Modify: `client/src/components/MultiplayerGame.tsx`

**Interfaces:**
- Consumes: `POST /api/game/:id/personality` endpoint, `SUBMIT_PERSONALITY` / `PERSONALITY_SEED_READY` socket events from Task 5
- Produces: `PersonalityQuiz` component, `getWeightedFragments(answers)` function, updated `GuardianScreen` with interspersed quiz flow

- [ ] **Step 1: Create OCEAN questions data**

Create `client/src/data/ocean-questions.ts`:

```typescript
export interface OceanQuestion {
  trait: string;
  prompt: string;
  options: { text: string; score: number }[];
}

export const OCEAN_QUESTIONS: OceanQuestion[] = [
  {
    trait: "openness",
    prompt: "You find out a friend is really into something you've never heard of — fermentation, birdwatching, speedcubing, whatever. You:",
    options: [
      { text: "Smile and nod. You're happy for them but you'll stick to what you know.", score: 1 },
      { text: "Ask a couple questions to be polite, but you probably won't look into it.", score: 2 },
      { text: "Go down a rabbit hole that night reading about it.", score: 3 },
      { text: "Show up next weekend with your own starter kit.", score: 4 },
    ],
  },
  {
    trait: "conscientiousness",
    prompt: "You've got a free Saturday with nothing planned. You:",
    options: [
      { text: "Wake up whenever, see where the day takes you.", score: 1 },
      { text: "Have a loose idea — maybe errands, maybe not.", score: 2 },
      { text: "Knock out your to-do list in the morning so you can relax later.", score: 3 },
      { text: "Already blocked it out on Thursday. Groceries, gym, that thing you've been putting off.", score: 4 },
    ],
  },
  {
    trait: "extraversion",
    prompt: "You're at a party where you only know the host. You:",
    options: [
      { text: "Find the dog or the bookshelf. Leave early. Recharge for three days.", score: 1 },
      { text: "Stick near the host, have a couple conversations, leave at a reasonable hour.", score: 2 },
      { text: "End up in a good conversation with a stranger, stay later than planned.", score: 3 },
      { text: "Leave with four new phone numbers and plans for next weekend.", score: 4 },
    ],
  },
  {
    trait: "agreeableness",
    prompt: "Your coworker takes credit for an idea you pitched last week. You:",
    options: [
      { text: "Call it out in the next meeting. Credit matters and they know what they did.", score: 1 },
      { text: "Mention it to them privately — firm but not aggressive.", score: 2 },
      { text: "Let it go this time but keep an eye on it. Not worth the conflict.", score: 3 },
      { text: "Honestly, you're just glad the idea is moving forward. Who cares who gets credit.", score: 4 },
    ],
  },
  {
    trait: "neuroticism",
    prompt: "You send a text to a close friend and they don't respond for two days. You:",
    options: [
      { text: "Assume they're busy. Check in if you don't hear back by the weekend.", score: 1 },
      { text: "Notice it, but figure they'll get back to you when they can.", score: 2 },
      { text: "Scroll back through your last few messages wondering if you said something weird.", score: 3 },
      { text: "Replay the conversation in your head at 2am. Definitely said something wrong.", score: 4 },
    ],
  },
];
```

- [ ] **Step 2: Create personality-tagged child fragments**

Create `client/src/data/child-fragments.ts`:

Move the `CHILD_THOUGHTS` array out of `GuardianScreen.tsx` and restructure it with personality tags:

```typescript
export interface TaggedFragment {
  text: string;
  traits: string[]; // e.g. ["high-openness", "low-neuroticism"] or ["neutral"]
}

export const TAGGED_FRAGMENTS: TaggedFragment[] = [
  // High Openness
  { text: "why is the sky so big?", traits: ["high-openness"] },
  { text: "what happens if i press this?", traits: ["high-openness"] },
  { text: "i want to go somewhere new.", traits: ["high-openness"] },
  { text: "i have an idea.", traits: ["high-openness"] },
  { text: "why are leaves green?", traits: ["high-openness"] },
  { text: "who made the stars?", traits: ["high-openness"] },
  { text: "where does the water go?", traits: ["high-openness"] },
  { text: "i learned something new.", traits: ["high-openness"] },
  { text: "i think the moon follows us.", traits: ["high-openness"] },
  { text: "everything goes somewhere.", traits: ["high-openness"] },
  // Low Openness
  { text: "i want to go home.", traits: ["low-openness"] },
  { text: "i don't like this.", traits: ["low-openness"] },
  { text: "can we go back?", traits: ["low-openness"] },
  { text: "i want to stay here forever.", traits: ["low-openness"] },
  { text: "that's not how it works.", traits: ["low-openness"] },
  // High Conscientiousness
  { text: "i tried my best.", traits: ["high-conscientiousness"] },
  { text: "i'm almost done.", traits: ["high-conscientiousness"] },
  { text: "i'm practicing.", traits: ["high-conscientiousness"] },
  { text: "i'm getting better.", traits: ["high-conscientiousness"] },
  { text: "i'll be more careful.", traits: ["high-conscientiousness"] },
  { text: "i'm being good.", traits: ["high-conscientiousness"] },
  { text: "i promise.", traits: ["high-conscientiousness"] },
  // Low Conscientiousness
  { text: "i forgot what i wanted.", traits: ["low-conscientiousness"] },
  { text: "i lost my sock.", traits: ["low-conscientiousness"] },
  { text: "i changed my mind.", traits: ["low-conscientiousness"] },
  { text: "i forgot the word.", traits: ["low-conscientiousness"] },
  { text: "i lost my place.", traits: ["low-conscientiousness"] },
  // High Extraversion
  { text: "we can play together.", traits: ["high-extraversion"] },
  { text: "i made a friend today.", traits: ["high-extraversion"] },
  { text: "look what i made!", traits: ["high-extraversion"] },
  { text: "watch me!", traits: ["high-extraversion"] },
  { text: "look at my drawing!", traits: ["high-extraversion"] },
  { text: "i want to show you something.", traits: ["high-extraversion"] },
  { text: "i'm coming!", traits: ["high-extraversion"] },
  { text: "i have something to say.", traits: ["high-extraversion"] },
  // Low Extraversion
  { text: "i'm hiding.", traits: ["low-extraversion"] },
  { text: "i'm still here.", traits: ["low-extraversion"] },
  { text: "i'm waiting.", traits: ["low-extraversion"] },
  { text: "it's too loud.", traits: ["low-extraversion"] },
  { text: "i'm right here.", traits: ["low-extraversion"] },
  // High Agreeableness
  { text: "i like sharing.", traits: ["high-agreeableness"] },
  { text: "can i help?", traits: ["high-agreeableness"] },
  { text: "i'm sorry.", traits: ["high-agreeableness"] },
  { text: "i love you most.", traits: ["high-agreeableness"] },
  { text: "i love you more.", traits: ["high-agreeableness"] },
  { text: "i drew a picture of us.", traits: ["high-agreeableness"] },
  // Low Agreeableness
  { text: "this is mine.", traits: ["low-agreeableness"] },
  { text: "i'm the boss.", traits: ["low-agreeableness"] },
  { text: "you can't catch me.", traits: ["low-agreeableness"] },
  { text: "it's not fair.", traits: ["low-agreeableness"] },
  { text: "i can do it myself.", traits: ["low-agreeableness"] },
  { text: "no.", traits: ["low-agreeableness"] },
  // High Neuroticism
  { text: "don't leave.", traits: ["high-neuroticism"] },
  { text: "are you there?", traits: ["high-neuroticism"] },
  { text: "i'm scared of the dark.", traits: ["high-neuroticism"] },
  { text: "why does it hurt?", traits: ["high-neuroticism"] },
  { text: "where are you going?", traits: ["high-neuroticism"] },
  { text: "stay here.", traits: ["high-neuroticism"] },
  { text: "i need help.", traits: ["high-neuroticism"] },
  // Low Neuroticism
  { text: "i can handle it.", traits: ["low-neuroticism"] },
  { text: "that's okay.", traits: ["low-neuroticism"] },
  { text: "i'll try again.", traits: ["low-neuroticism"] },
  { text: "i'm brave today.", traits: ["low-neuroticism"] },
  { text: "i'm strong enough.", traits: ["low-neuroticism"] },
  // Neutral — general kid thoughts for the base pool
  { text: "can i have juice?", traits: ["neutral"] },
  { text: "where did the moon go?", traits: ["neutral"] },
  { text: "i'm not tired.", traits: ["neutral"] },
  { text: "what's that sound?", traits: ["neutral"] },
  { text: "i found a rock.", traits: ["neutral"] },
  { text: "i'm hungry again.", traits: ["neutral"] },
  { text: "beep beep.", traits: ["neutral"] },
  { text: "can we have pizza?", traits: ["neutral"] },
  { text: "i want pancakes.", traits: ["neutral"] },
  { text: "the floor is lava.", traits: ["neutral"] },
  { text: "i'm a superhero.", traits: ["neutral"] },
  { text: "i'm a dinosaur.", traits: ["neutral"] },
  { text: "i found a penny.", traits: ["neutral"] },
  { text: "the sky is crying.", traits: ["neutral"] },
  { text: "the sun went to sleep.", traits: ["neutral"] },
  { text: "i saw a bird.", traits: ["neutral"] },
  { text: "it was blue.", traits: ["neutral"] },
  { text: "i built a tower.", traits: ["neutral"] },
  { text: "i'm thirsty.", traits: ["neutral"] },
  { text: "that smells funny.", traits: ["neutral"] },
  { text: "flush!", traits: ["neutral"] },
  { text: "one more story?", traits: ["neutral"] },
  { text: "the stars are blinking.", traits: ["neutral"] },
  { text: "i don't know.", traits: ["neutral"] },
  { text: "maybe tomorrow.", traits: ["neutral"] },
  { text: "i pick both.", traits: ["neutral"] },
];

const TRAIT_NAMES = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"] as const;

export function getWeightedFragments(answers: (number | null)[]): string[] {
  const neutral = TAGGED_FRAGMENTS.filter((f) => f.traits.includes("neutral")).map((f) => f.text);
  const matched: string[] = [];

  answers.forEach((score, i) => {
    if (score === null) return;
    const trait = TRAIT_NAMES[i];
    const direction = score >= 3 ? "high" : "low";
    const tag = `${direction}-${trait}`;
    matched.push(...TAGGED_FRAGMENTS.filter((f) => f.traits.includes(tag)).map((f) => f.text));
  });

  // Weight: 2x matched fragments mixed with neutral pool
  return [...neutral, ...matched, ...matched];
}
```

- [ ] **Step 3: Create PersonalityQuiz component**

Create `client/src/components/PersonalityQuiz.tsx`:

```typescript
import { useState } from "react";
import { OCEAN_QUESTIONS } from "../data/ocean-questions";
import { track } from "../analytics";

interface Props {
  questionIndex: number;
  onAnswer: (questionIndex: number, score: number) => void;
}

export function PersonalityQuiz({ questionIndex, onAnswer }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [fading, setFading] = useState(false);
  const question = OCEAN_QUESTIONS[questionIndex];
  if (!question) return null;

  const handleSelect = (score: number) => {
    if (selected !== null) return;
    setSelected(score);
    track("ocean_answer", { trait: question.trait, score });
    setFading(true);
    setTimeout(() => {
      onAnswer(questionIndex, score);
      setSelected(null);
      setFading(false);
    }, 600);
  };

  return (
    <div className={`personality-quiz${fading ? " quiz-fading" : ""}`}>
      <p className="quiz-prompt">{question.prompt}</p>
      <div className="quiz-options">
        {question.options.map((opt, i) => (
          <button
            key={i}
            className={`quiz-option${selected === opt.score ? " selected" : ""}`}
            onClick={() => handleSelect(opt.score)}
            disabled={selected !== null}
          >
            {opt.text}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create ConfessionalPrompts component**

Create `client/src/components/ConfessionalPrompts.tsx`:

```typescript
import { useState } from "react";
import { track } from "../analytics";

interface Props {
  onSubmit: (confessional1: string, confessional2: string) => void;
  submitting: boolean;
}

export function ConfessionalPrompts({ onSubmit, submitting }: Props) {
  const [c1, setC1] = useState("");
  const [c2, setC2] = useState("");

  const handleSubmit = () => {
    track("confessionals_submitted", { c1Length: c1.length, c2Length: c2.length });
    onSubmit(c1, c2);
  };

  return (
    <div className="confessional-prompts">
      <div className="confessional">
        <label className="confessional-label">
          what's the most evil thing you did as a kid (ages 3-7)?
        </label>
        <textarea
          className="confessional-input"
          value={c1}
          onChange={(e) => setC1(e.target.value.slice(0, 500))}
          placeholder="I told my sister her hamster ran away. It didn't run away."
          maxLength={500}
          rows={3}
        />
      </div>
      <div className="confessional">
        <label className="confessional-label">
          what's one thing you never told your parents?
        </label>
        <textarea
          className="confessional-input"
          value={c2}
          onChange={(e) => setC2(e.target.value.slice(0, 500))}
          placeholder="I failed a class sophomore year and forged the report card."
          maxLength={500}
          rows={3}
        />
      </div>
      <button
        className="btn"
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? "..." : "done"}
      </button>
      <p className="confessional-skip dim">both are optional</p>
    </div>
  );
}
```

- [ ] **Step 5: Rewrite GuardianScreen to intersperse quiz with intro lines**

Rewrite `client/src/components/GuardianScreen.tsx` to weave intro beats and quiz questions together. The key changes:

1. Remove the inline `CHILD_THOUGHTS` array — import from `child-fragments.ts`
2. Add quiz state tracking (current question index, answers array)
3. Intersperse: intro beat → quiz question → intro beat → quiz question ...
4. After all 5 questions + portrait reveal, show confessionals
5. After confessionals submit, call the personality API
6. Use `getWeightedFragments(answers)` for the cycling thoughts

The component flow becomes a stepped state machine:

```
Step 0: Intro beat 1 (age 0 lines auto-advance)
Step 1: OCEAN Q1 (Openness) — appears after beat 1
Step 2: Intro beat 2 (age 1 lines auto-advance after Q1 answered)
Step 3: OCEAN Q2 (Conscientiousness)
Step 4: Intro beat 3 (age 2 lines auto-advance)
Step 5: OCEAN Q3 (Extraversion)
Step 6: "three years old." line
Step 7: OCEAN Q4 (Agreeableness)
Step 8: OCEAN Q5 (Neuroticism)
Step 9: Portrait reveal + confessionals
Step 10: Waiting for seed → "I'm ready" buttons
```

Update the Props to accept an `onPersonalitySubmit` callback:

```typescript
interface Props {
  childName: string;
  gameId: string | null;
  eventReady: boolean;
  seedReady: boolean;
  onReady: () => void;
  onPersonalitySubmit: (ocean: number[], confessional1: string, confessional2: string) => void;
}
```

The full implementation is substantial — build the step-based flow using the existing intro animation pattern (timed line reveals) combined with the `PersonalityQuiz` component for interactive steps. The cycling child thought fragment uses `getWeightedFragments(answers)` and updates its pool each time an answer comes in.

- [ ] **Step 6: Add `submitPersonality` to useGame hook**

In `client/src/hooks/useGame.ts`, add a new function:

```typescript
const [seedReady, setSeedReady] = useState(false);

const submitPersonality = useCallback(
  async (ocean: number[], confessional1: string, confessional2: string) => {
    if (!gameId) return;
    const res = await fetch(`${API}/game/${gameId}/personality`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ocean, confessional1, confessional2 }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ready) setSeedReady(true);
    }
  },
  [gameId]
);
```

Add `seedReady` and `submitPersonality` to the return object.

- [ ] **Step 7: Add personality socket events to useMultiplayer hook**

In `client/src/hooks/useMultiplayer.ts`, add listener for `PERSONALITY_SEED_READY`:

```typescript
socket.on("personality_seed_ready", () => {
  setSeedReady(true);
});
```

Add `submitPersonality` that emits the `submit_personality` socket event:

```typescript
const submitPersonality = useCallback(
  (ocean: number[], confessional1: string, confessional2: string) => {
    ensureSocket().emit("submit_personality", { ocean, confessional1, confessional2 });
  },
  [ensureSocket]
);
```

- [ ] **Step 8: Update SoloGame.tsx to pass new props to GuardianScreen**

```typescript
<GuardianScreen
  childName={childName || nameInput}
  gameId={gameId}
  eventReady={phase === "event_intro" && !loadingEvent}
  seedReady={seedReady}
  onReady={() => setShowGuardian(false)}
  onPersonalitySubmit={submitPersonality}
/>
```

- [ ] **Step 9: Update MultiplayerGame.tsx similarly**

Pass `seedReady`, `submitPersonality` from the multiplayer hook to the GuardianScreen.

- [ ] **Step 10: Add CSS styles for quiz and confessional components**

Add styles to the existing stylesheet (wherever the guardian screen styles live — likely `client/src/index.css` or similar):

```css
.personality-quiz { animation: fadeIn 0.4s ease-in; margin: 1.5rem 0; }
.quiz-fading { animation: fadeOut 0.5s ease-out; }
.quiz-prompt { font-style: italic; margin-bottom: 1rem; font-size: 0.95rem; }
.quiz-options { display: flex; flex-direction: column; gap: 0.5rem; }
.quiz-option { text-align: left; padding: 0.75rem 1rem; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; transition: all 0.2s; font-size: 0.9rem; }
.quiz-option:hover:not(:disabled) { border-color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.05); }
.quiz-option.selected { border-color: rgba(255,255,255,0.6); background: rgba(255,255,255,0.1); }

.confessional-prompts { animation: fadeIn 0.4s ease-in; margin: 1.5rem 0; }
.confessional { margin-bottom: 1.5rem; }
.confessional-label { display: block; font-style: italic; margin-bottom: 0.5rem; font-size: 0.95rem; }
.confessional-input { width: 100%; padding: 0.75rem; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; background: rgba(0,0,0,0.3); color: inherit; font-family: inherit; font-size: 0.9rem; resize: vertical; }
.confessional-skip { margin-top: 0.5rem; font-size: 0.8rem; }
```

- [ ] **Step 11: Test in browser**

Run: `cd client && npm run dev`
Open the app, start a new game. Verify:
- Intro lines appear, then first quiz question fades in
- Answering triggers next intro beat + next question
- After all 5 questions, portrait reveals, confessionals appear
- Submitting confessionals shows "I'm ready" button
- Child thought fragments shift based on quiz answers

- [ ] **Step 12: Commit**

```bash
git add client/src/components/PersonalityQuiz.tsx client/src/components/ConfessionalPrompts.tsx client/src/data/ocean-questions.ts client/src/data/child-fragments.ts client/src/components/GuardianScreen.tsx client/src/hooks/useGame.ts client/src/hooks/useMultiplayer.ts client/src/components/SoloGame.tsx client/src/components/MultiplayerGame.tsx
git commit -m "feat: guardian screen personality quiz with interspersed intro flow

Five OCEAN questions woven between age 0/1/2 intro narrative beats.
Confessionals appear after portrait reveal. Child thought fragments
become personality-tagged and shift based on quiz answers. Solo game
submits via REST API; multiplayer uses socket events.
"
```

---

### Task 7: Integration Testing and Cleanup

**Files:**
- Modify: `server/tests/conversation-engine.test.ts` (fix temperament references)
- Modify: `server/tests/e2e-rest-playthrough.test.ts` (add personality step)
- Modify: `server/tests/multiplayer-integration.test.ts` (add personality step)
- Run: full test suite

**Interfaces:**
- Consumes: All prior tasks
- Produces: Passing test suite, no remaining `temperament` references

- [ ] **Step 1: Find and fix all remaining temperament references**

Run: `grep -rn "temperament" server/src/ client/src/ --include="*.ts" --include="*.tsx"`
Fix every remaining reference. Common spots:
- Test fixture files in `server/tests/fixtures/` or `server/tests/helpers/`
- Any mock game state construction in tests

- [ ] **Step 2: Update conversation-engine.test.ts**

Any test that creates a `GameState` manually needs `personalitySeed` instead of `temperament`. Update mock states.

- [ ] **Step 3: Update e2e-rest-playthrough.test.ts**

Add a personality submission step after game creation and before the first event:

```typescript
// After creating game:
const personalityRes = await request(app)
  .post(`/api/game/${gameId}/personality`)
  .send({
    ocean: [3, 2, 3, 2, 3],
    confessional1: "I broke my sister's doll",
    confessional2: "I ate all the cookies and blamed the dog",
  });
expect(personalityRes.status).toBe(200);
expect(personalityRes.body.ready).toBe(true);
```

- [ ] **Step 4: Run the full test suite**

Run: `cd server && npx vitest run --reporter=verbose 2>&1 | tail -60`
Expected: All tests pass

- [ ] **Step 5: Run the client build to check for type errors**

Run: `cd client && npx tsc --noEmit 2>&1 | tail -20`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: update all tests for personality system, fix remaining temperament references"
```
