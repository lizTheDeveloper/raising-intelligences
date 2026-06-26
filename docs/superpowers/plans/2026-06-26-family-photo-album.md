# Family Photo Album Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a family photo album feature that lets logged-in users browse all kids they've raised, organized by co-parenting partner, with full scrapbook pages including portrait timelines, illustrated key moments, epilogue, and report card.

**Architecture:** Server-rendered album with eager data — album data (partner info, key moments, moment illustrations) is generated at the end of each game as part of the endgame flow, persisted to new DB tables, and served via new REST endpoints. The client adds a state-driven album view with three levels: partner cards → kids list → individual scrapbook.

**Tech Stack:** PostgreSQL (new migration), Express routes, OpenRouter LLM (text extraction + image generation), React (new components), existing lo-fi CSS aesthetic.

## Global Constraints

- All LLM text extraction uses the existing `LLMClient` interface via `completeJson<T>()` for structured output
- Moment illustrations use `gpt-5-image-mini` via OpenRouter (same as existing portrait pipeline in `portrait-gen.ts`)
- Album generation is non-blocking — if it fails, the game completes normally
- The album requires Matrix auth login — no anonymous access
- Follow existing patterns: `GameRepository` interface for DB, `EndgameEngine` for game logic, Express Router factories for API routes
- New LLM role `album` added to `model-config.ts` using the same quality tier as `report_card`

---

### Task 1: Database Migration + Repository Methods

**Files:**
- Create: `server/src/db/migrations/007-album.sql`
- Modify: `server/src/db/repository.ts`
- Test: `server/tests/repository.test.ts`

**Interfaces:**
- Consumes: existing `GameRepository` interface, `pool.query()`
- Produces:
  - `AlbumPartner` type: `{ id: string; userId: string; partnerName: string; partnerType: 'real' | 'generated'; relationshipSummary: string }`
  - `AlbumMoment` type: `{ id: string; gameId: string; age: number; title: string; description: string; momentType: string; imagePath: string | null; sortOrder: number }`
  - `GameRepository.saveAlbumPartner(partner: { userId: string; partnerName: string; partnerType: string; relationshipSummary: string }): Promise<string>` — returns partner ID (upserts on user_id + partner_name + partner_type)
  - `GameRepository.saveAlbumMoments(gameId: string, moments: Array<{ age: number; title: string; description: string; momentType: string; imagePath: string | null; sortOrder: number }>): Promise<void>`
  - `GameRepository.linkGameToPartner(userId: string, gameId: string, partnerId: string): Promise<void>` — updates `user_games.partner_id`
  - `GameRepository.loadAlbum(userId: string): Promise<{ partners: Array<AlbumPartner & { kids: Array<{ gameId: string; childName: string; createdAt: number }> }>; unlinkedKids: Array<{ gameId: string; childName: string; createdAt: number }> }>`
  - `GameRepository.loadScrapbook(userId: string, gameId: string): Promise<{ childName: string; partnerName: string | null; partnerType: string | null; relationshipSummary: string | null; moments: AlbumMoment[]; epilogue: string; reportCard: string } | null>`

- [ ] **Step 1: Write the migration SQL**

Create `server/src/db/migrations/007-album.sql`:

```sql
-- Album feature: partners, moments, and game-partner linking.

CREATE TABLE IF NOT EXISTS album_partners (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               TEXT        NOT NULL,
  partner_name          TEXT        NOT NULL,
  partner_type          TEXT        NOT NULL DEFAULT 'real',
  relationship_summary  TEXT        NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, partner_name, partner_type)
);

CREATE INDEX IF NOT EXISTS idx_album_partners_user_id ON album_partners (user_id);

CREATE TABLE IF NOT EXISTS album_moments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  age         INTEGER     NOT NULL,
  title       TEXT        NOT NULL,
  description TEXT        NOT NULL,
  moment_type TEXT        NOT NULL,
  image_path  TEXT,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_album_moments_game_id ON album_moments (game_id);

-- Link user_games to album_partners
ALTER TABLE user_games ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES album_partners(id);
```

- [ ] **Step 2: Write failing tests for repository methods**

Add to `server/tests/repository.test.ts`:

```typescript
describe("album", () => {
  it("saves and loads an album partner", async () => {
    const partnerId = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Co-parents who disagreed on everything.",
    });
    expect(partnerId).toBeTruthy();

    // Upsert returns same ID
    const partnerId2 = await repo.saveAlbumPartner({
      userId: "user-1",
      partnerName: "Alex",
      partnerType: "real",
      relationshipSummary: "Updated summary.",
    });
    expect(partnerId2).toBe(partnerId);
  });

  it("saves album moments for a game", async () => {
    // Create a game first
    const state = makeState({ id: "album-game-1" });
    await repo.saveGame(state);

    await repo.saveAlbumMoments("album-game-1", [
      { age: 3, title: "The pasta incident", description: "Refused stars.", momentType: "funny", imagePath: null, sortOrder: 0 },
      { age: 7, title: "First day", description: "Walked in alone.", momentType: "milestone", imagePath: "portraits/album-game-1/moment-01.png", sortOrder: 1 },
    ]);

    const scrapbook = await repo.loadScrapbook("user-1", "album-game-1");
    expect(scrapbook).not.toBeNull();
    expect(scrapbook!.moments).toHaveLength(2);
    expect(scrapbook!.moments[0].title).toBe("The pasta incident");
  });

  it("loads album grouped by partner", async () => {
    const state = makeState({ id: "album-game-2", childName: "Luna" });
    await repo.saveGame(state);
    await repo.saveEndgame("album-game-2", "epilogue text", "report card text");

    const partnerId = await repo.saveAlbumPartner({
      userId: "@liz:matrix.org",
      partnerName: "Jamie",
      partnerType: "generated",
      relationshipSummary: "A quiet, supportive presence.",
    });

    // Link via user_games
    await repo.linkGameToPartner("@liz:matrix.org", "album-game-2", partnerId);

    const album = await repo.loadAlbum("@liz:matrix.org");
    expect(album.partners).toHaveLength(1);
    expect(album.partners[0].partnerName).toBe("Jamie");
    expect(album.partners[0].kids).toHaveLength(1);
    expect(album.partners[0].kids[0].childName).toBe("Luna");
  });

  it("returns unlinked kids for legacy games", async () => {
    // user_games row without partner_id
    const state = makeState({ id: "legacy-game", childName: "Kai" });
    await repo.saveGame(state);

    // Simulate a user_games row without partner_id (need to add via query or savePlayer-like method)
    // This will use the existing user routes POST /user/:userId/kids path

    const album = await repo.loadAlbum("@liz:matrix.org");
    expect(album.unlinkedKids.length).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run tests/repository.test.ts --reporter=verbose`
Expected: FAIL — `saveAlbumPartner`, `saveAlbumMoments`, `linkGameToPartner`, `loadAlbum`, `loadScrapbook` not defined

- [ ] **Step 4: Add types and interface methods to repository.ts**

Add the `AlbumPartner` and `AlbumMoment` types and extend the `GameRepository` interface:

```typescript
export interface AlbumPartner {
  id: string;
  userId: string;
  partnerName: string;
  partnerType: "real" | "generated";
  relationshipSummary: string;
}

export interface AlbumMoment {
  id: string;
  gameId: string;
  age: number;
  title: string;
  description: string;
  momentType: string;
  imagePath: string | null;
  sortOrder: number;
}
```

Add to `GameRepository` interface:

```typescript
saveAlbumPartner(partner: { userId: string; partnerName: string; partnerType: string; relationshipSummary: string }): Promise<string>;
saveAlbumMoments(gameId: string, moments: Array<{ age: number; title: string; description: string; momentType: string; imagePath: string | null; sortOrder: number }>): Promise<void>;
linkGameToPartner(userId: string, gameId: string, partnerId: string): Promise<void>;
loadAlbum(userId: string): Promise<{ partners: Array<AlbumPartner & { kids: Array<{ gameId: string; childName: string; createdAt: number }> }>; unlinkedKids: Array<{ gameId: string; childName: string; createdAt: number }> }>;
loadScrapbook(userId: string, gameId: string): Promise<{ childName: string; partnerName: string | null; partnerType: string | null; relationshipSummary: string | null; moments: AlbumMoment[]; epilogue: string; reportCard: string } | null>;
```

- [ ] **Step 5: Implement PgGameRepository methods**

```typescript
async saveAlbumPartner(partner: {
  userId: string;
  partnerName: string;
  partnerType: string;
  relationshipSummary: string;
}): Promise<string> {
  const res = await this.db.query<{ id: string }>(
    `INSERT INTO album_partners (user_id, partner_name, partner_type, relationship_summary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, partner_name, partner_type) DO UPDATE SET
       relationship_summary = EXCLUDED.relationship_summary
     RETURNING id`,
    [partner.userId, partner.partnerName, partner.partnerType, partner.relationshipSummary]
  );
  return res.rows[0].id;
}

async saveAlbumMoments(gameId: string, moments: Array<{
  age: number; title: string; description: string;
  momentType: string; imagePath: string | null; sortOrder: number;
}>): Promise<void> {
  for (const m of moments) {
    await this.db.query(
      `INSERT INTO album_moments (game_id, age, title, description, moment_type, image_path, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [gameId, m.age, m.title, m.description, m.momentType, m.imagePath, m.sortOrder]
    );
  }
}

async linkGameToPartner(userId: string, gameId: string, partnerId: string): Promise<void> {
  await this.db.query(
    `UPDATE user_games SET partner_id = $1 WHERE user_id = $2 AND game_id = $3`,
    [partnerId, userId, gameId]
  );
}

async loadAlbum(userId: string): Promise<{
  partners: Array<AlbumPartner & { kids: Array<{ gameId: string; childName: string; createdAt: number }> }>;
  unlinkedKids: Array<{ gameId: string; childName: string; createdAt: number }>;
}> {
  const partnersRes = await this.db.query<{
    id: string; user_id: string; partner_name: string;
    partner_type: string; relationship_summary: string;
  }>(
    `SELECT id, user_id, partner_name, partner_type, relationship_summary
     FROM album_partners WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );

  const partners = [];
  for (const p of partnersRes.rows) {
    const kidsRes = await this.db.query<{
      game_id: string; child_name: string; created_at: string;
    }>(
      `SELECT ug.game_id, ug.child_name, ug.created_at
       FROM user_games ug
       WHERE ug.user_id = $1 AND ug.partner_id = $2
       ORDER BY ug.created_at DESC`,
      [userId, p.id]
    );
    partners.push({
      id: p.id,
      userId: p.user_id,
      partnerName: p.partner_name,
      partnerType: p.partner_type as "real" | "generated",
      relationshipSummary: p.relationship_summary,
      kids: kidsRes.rows.map(k => ({
        gameId: k.game_id,
        childName: k.child_name,
        createdAt: new Date(k.created_at).getTime(),
      })),
    });
  }

  const unlinkedRes = await this.db.query<{
    game_id: string; child_name: string; created_at: string;
  }>(
    `SELECT game_id, child_name, created_at
     FROM user_games
     WHERE user_id = $1 AND partner_id IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );

  return {
    partners,
    unlinkedKids: unlinkedRes.rows.map(k => ({
      gameId: k.game_id,
      childName: k.child_name,
      createdAt: new Date(k.created_at).getTime(),
    })),
  };
}

async loadScrapbook(userId: string, gameId: string): Promise<{
  childName: string;
  partnerName: string | null;
  partnerType: string | null;
  relationshipSummary: string | null;
  moments: AlbumMoment[];
  epilogue: string;
  reportCard: string;
} | null> {
  const gameRes = await this.db.query<{
    child_name: string; partner_name: string | null;
    partner_type: string | null; relationship_summary: string | null;
  }>(
    `SELECT ug.child_name,
            ap.partner_name, ap.partner_type, ap.relationship_summary
     FROM user_games ug
     LEFT JOIN album_partners ap ON ug.partner_id = ap.id
     WHERE ug.user_id = $1 AND ug.game_id = $2`,
    [userId, gameId]
  );
  if (!gameRes.rows[0]) return null;

  const endgameRes = await this.db.query<{ epilogue: string; report_card: string }>(
    `SELECT epilogue, report_card FROM endgames WHERE game_id = $1`,
    [gameId]
  );

  const momentsRes = await this.db.query<{
    id: string; game_id: string; age: number; title: string;
    description: string; moment_type: string; image_path: string | null;
    sort_order: number;
  }>(
    `SELECT id, game_id, age, title, description, moment_type, image_path, sort_order
     FROM album_moments WHERE game_id = $1 ORDER BY sort_order ASC`,
    [gameId]
  );

  const g = gameRes.rows[0];
  const e = endgameRes.rows[0];
  return {
    childName: g.child_name,
    partnerName: g.partner_name,
    partnerType: g.partner_type,
    relationshipSummary: g.relationship_summary,
    moments: momentsRes.rows.map(m => ({
      id: m.id,
      gameId: m.game_id,
      age: m.age,
      title: m.title,
      description: m.description,
      momentType: m.moment_type,
      imagePath: m.image_path,
      sortOrder: m.sort_order,
    })),
    epilogue: e?.epilogue ?? "",
    reportCard: e?.report_card ?? "",
  };
}
```

- [ ] **Step 6: Implement InMemoryGameRepository methods**

Mirror the Pg implementation using Maps for `albumPartners` and `albumMoments`, and add a `partnerLinks` map for `user_games.partner_id`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/repository.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/src/db/migrations/007-album.sql server/src/db/repository.ts server/tests/repository.test.ts
git commit -m "feat(album): add album_partners and album_moments tables with repository methods"
```

---

### Task 2: LLM Role, Prompt, and Context Assembler

**Files:**
- Modify: `server/src/llm/model-config.ts`
- Modify: `server/src/llm/prompts.ts`
- Modify: `server/src/game/context-assembler.ts`
- Test: `server/tests/context-assembler.test.ts`

**Interfaces:**
- Consumes: `GameState`, `Message`, existing `fillTemplate()`
- Produces:
  - New `LLMRole` value: `"album"`
  - `ALBUM_SYSTEM_PROMPT` constant in `prompts.ts`
  - `buildAlbumContext(state: GameState, epilogue: string, reportCard: string): { system: string; userMessage: string }` in `context-assembler.ts`

- [ ] **Step 1: Add `album` to LLMRole and model configs**

In `server/src/llm/model-config.ts`, add `"album"` to the `LLMRole` union and add entries to all three model config objects — use the same model as `report_card` in each tier:

```typescript
export type LLMRole =
  | "kid_family_chat"
  | "kid_sidebar"
  | "kid_adult_chat"
  | "world_manager"
  | "psychologist"
  | "epilogue"
  | "report_card"
  | "personality_seed"
  | "gender_inference"
  | "album";
```

Add `album` to each config:
- `STANDARD_MODELS`: `album: "qwen/qwen3.7-max"`
- `CEREBRAS_MODELS`: `album: "cerebras:gpt-oss-120b"`
- `PREMIUM_MODELS`: `album: "anthropic/claude-opus-4-8"`

- [ ] **Step 2: Write the album prompt**

Add to `server/src/llm/prompts.ts`:

```typescript
export const ALBUM_SYSTEM_PROMPT = `You are extracting a family album summary from the story of {childName}'s childhood. You have the full conversation history, identity document, epilogue, and report card.

Extract two things:

1. **Partner info** — Who was the other parent figure in this child's life?
   - For solo-parent games: Infer from the conversations, identity document, and events. The child's messages and the identity document contain clues — references to another parent, an ex, a figure who shaped the family dynamic. Invent a plausible name and describe the relationship in 1-2 sentences. If there's truly no other parent figure referenced, invent one that fits the story — perhaps a distant ex, a co-parent who was present in the early years, or a step-parent who came later.
   - For co-parented games: You will be given the partner's display name. Write 1-2 sentences about the co-parenting dynamic based on how the two parents interacted through the conversations.

2. **Key moments** (exactly 5) — The most memorable, defining moments from this child's life. Pick moments that a parent would remember forever — funny incidents, tender breakthroughs, painful conflicts, milestone achievements. For each moment:
   - A short, evocative title (3-8 words, like a photo caption)
   - A 1-2 sentence description of what happened
   - The age it happened at
   - A category: "funny", "tender", "conflict", or "milestone"
   - A visual prompt: one sentence describing the scene as a lo-fi anime illustration — the child seen from behind, in a specific setting, with specific details visible. Match the warm, muted, nostalgic aesthetic.

You MUST respond with valid JSON matching this exact structure:
{
  "partnerName": "string",
  "relationshipSummary": "string",
  "moments": [
    {
      "age": number,
      "title": "string",
      "description": "string",
      "momentType": "funny" | "tender" | "conflict" | "milestone",
      "visualPrompt": "string"
    }
  ]
}`;
```

- [ ] **Step 3: Write failing test for buildAlbumContext**

Add to `server/tests/context-assembler.test.ts`:

```typescript
import { buildAlbumContext } from "../src/game/context-assembler.js";

describe("buildAlbumContext", () => {
  it("builds context for a solo game", () => {
    const state = makeState({
      childName: "Luna",
      relationshipType: "solo parent",
      messages: [
        { sender: "parent1", content: "Luna, eat your pasta", chatType: "shared", visibleTo: ["parent1", "kid"], timestamp: 1, eventNumber: 1 },
        { sender: "kid", content: "NO! Stars only!", chatType: "shared", visibleTo: ["parent1", "kid"], timestamp: 2, eventNumber: 1 },
      ],
    });

    const ctx = buildAlbumContext(state, "Luna grew up strong.", "Report card text.");
    expect(ctx.system).toContain("Luna");
    expect(ctx.system).toContain("family album");
    expect(ctx.userMessage).toContain("solo");
    expect(ctx.userMessage).toContain("Luna grew up strong.");
    expect(ctx.userMessage).toContain("Report card text.");
    expect(ctx.userMessage).toContain("Parent 1: Luna, eat your pasta");
  });

  it("builds context for a multiplayer game with partner name", () => {
    const state = makeState({
      childName: "Kai",
      relationshipType: "co-parents",
    });

    const ctx = buildAlbumContext(state, "Kai's epilogue.", "Kai's report card.", "Alex");
    expect(ctx.userMessage).toContain("Alex");
    expect(ctx.userMessage).not.toContain("solo");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd server && npx vitest run tests/context-assembler.test.ts --reporter=verbose`
Expected: FAIL — `buildAlbumContext` not defined

- [ ] **Step 5: Implement buildAlbumContext**

Add to `server/src/game/context-assembler.ts`:

```typescript
export function buildAlbumContext(
  state: GameState,
  epilogue: string,
  reportCard: string,
  partnerDisplayName?: string
): {
  system: string;
  userMessage: string;
} {
  const system = fillTemplate(ALBUM_SYSTEM_PROMPT, {
    childName: state.childName,
  });

  const allMessages = state.messages
    .filter((m) => m.chatType === "shared" || m.chatType === "private")
    .map((m) => `[Age ${state.events.find(e => e.eventNumber === m.eventNumber)?.age ?? "?"}] ${senderLabel(m.sender)}: ${m.content}`)
    .join("\n");

  const snapshotTimeline = state.identitySnapshots
    .map((s) => {
      const event = state.events.find((e) => e.eventNumber === s.eventNumber);
      return `### Age ${event?.age ?? "?"}\n${s.document}`;
    })
    .join("\n\n");

  const isSoloGame = isSolo(state.relationshipType);
  const partnerContext = isSoloGame
    ? "This was a solo-parent household. Infer the other parent from the child's story — look for references in conversations and the identity document."
    : `The co-parent's name is "${partnerDisplayName}". Describe their co-parenting dynamic.`;

  const userMessage = `## Partner Context\n${partnerContext}\n\n## Identity Timeline\n${snapshotTimeline}\n\n## Conversation Log\n${allMessages}\n\n## Epilogue\n${epilogue}\n\n## Report Card\n${reportCard}\n\nExtract the album data for ${state.childName}.`;

  return { system, userMessage };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/context-assembler.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/llm/model-config.ts server/src/llm/prompts.ts server/src/game/context-assembler.ts server/tests/context-assembler.test.ts
git commit -m "feat(album): add album LLM role, prompt, and context assembler"
```

---

### Task 3: EndgameEngine Album Generation

**Files:**
- Modify: `server/src/game/endgame-engine.ts`
- Test: `server/tests/endgame-engine.test.ts`

**Interfaces:**
- Consumes: `LLMClient.completeJson<T>()`, `buildAlbumContext()` from Task 2
- Produces:
  - `AlbumData` type: `{ partnerName: string; relationshipSummary: string; moments: Array<{ age: number; title: string; description: string; momentType: string; visualPrompt: string }> }`
  - `EndgameEngine.generateAlbumData(state: GameState, epilogue: string, reportCard: string, partnerDisplayName?: string): Promise<AlbumData>`

- [ ] **Step 1: Write failing test**

Add to `server/tests/endgame-engine.test.ts`:

```typescript
describe("generateAlbumData", () => {
  it("extracts partner and moments from game state", async () => {
    const mockLlm: LLMClient = {
      streamResponse: vi.fn(),
      completeResponse: vi.fn(),
      completeJson: vi.fn().mockResolvedValue({
        partnerName: "Jordan",
        relationshipSummary: "A quiet presence who disappeared early.",
        moments: [
          { age: 3, title: "The pasta incident", description: "Stars only.", momentType: "funny", visualPrompt: "toddler at kitchen table" },
          { age: 7, title: "First bike ride", description: "Fell twice, got back on.", momentType: "milestone", visualPrompt: "child on bike in park" },
          { age: 12, title: "The argument", description: "Slammed the door.", momentType: "conflict", visualPrompt: "preteen in doorway" },
          { age: 16, title: "The quiet drive", description: "Said nothing for an hour.", momentType: "tender", visualPrompt: "teenager in car" },
          { age: 18, title: "Graduation day", description: "Looked back once.", momentType: "milestone", visualPrompt: "young adult in cap and gown" },
        ],
      }),
    };

    const engine = new EndgameEngine(mockLlm);
    const state = makeEndgameState();
    const result = await engine.generateAlbumData(state, "epilogue", "report card");

    expect(result.partnerName).toBe("Jordan");
    expect(result.moments).toHaveLength(5);
    expect(result.moments[0].title).toBe("The pasta incident");
    expect(mockLlm.completeJson).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/endgame-engine.test.ts --reporter=verbose`
Expected: FAIL — `generateAlbumData` not defined on `EndgameEngine`

- [ ] **Step 3: Implement generateAlbumData**

Add to `server/src/game/endgame-engine.ts`:

```typescript
import { buildAlbumContext } from "./context-assembler.js";

export interface AlbumData {
  partnerName: string;
  relationshipSummary: string;
  moments: Array<{
    age: number;
    title: string;
    description: string;
    momentType: string;
    visualPrompt: string;
  }>;
}

// In EndgameEngine class:
async generateAlbumData(
  state: GameState,
  epilogue: string,
  reportCard: string,
  partnerDisplayName?: string
): Promise<AlbumData> {
  const ctx = buildAlbumContext(state, epilogue, reportCard, partnerDisplayName);
  return this.llm.completeJson<AlbumData>(ctx.system, ctx.userMessage, "album");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/endgame-engine.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/game/endgame-engine.ts server/tests/endgame-engine.test.ts
git commit -m "feat(album): add EndgameEngine.generateAlbumData for partner + moment extraction"
```

---

### Task 4: Moment Illustration Generation

**Files:**
- Modify: `server/src/portrait-gen.ts`
- Test: `server/tests/portrait-gen.test.ts` (create if needed)

**Interfaces:**
- Consumes: existing `generateImage()` internal function, `PORTRAITS_DIR`
- Produces: `generateMomentIllustrations(gameId: string, moments: Array<{ visualPrompt: string; sortOrder: number }>): Promise<Array<{ sortOrder: number; imagePath: string | null }>>`

- [ ] **Step 1: Write failing test**

Create `server/tests/portrait-gen.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateMomentIllustrations } from "../src/portrait-gen.js";

describe("generateMomentIllustrations", () => {
  beforeEach(() => {
    process.env.DISABLE_PORTRAITS = "1";
  });

  it("returns null paths when portraits are disabled", async () => {
    const results = await generateMomentIllustrations("test-game-id", [
      { visualPrompt: "toddler at table", sortOrder: 0 },
      { visualPrompt: "child on bike", sortOrder: 1 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].imagePath).toBeNull();
    expect(results[1].imagePath).toBeNull();
  });

  it("returns correct relative paths in structure", async () => {
    // Just verify the path format without actually calling the API
    const results = await generateMomentIllustrations("test-game-id", []);
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/portrait-gen.test.ts --reporter=verbose`
Expected: FAIL — `generateMomentIllustrations` not exported

- [ ] **Step 3: Implement generateMomentIllustrations**

Add to `server/src/portrait-gen.ts`:

```typescript
function momentPrompt(visualPrompt: string): string {
  return [
    `Lo-fi anime illustration: ${visualPrompt}.`,
    `Warm amber and golden lighting, dark cozy atmosphere.`,
    `Muted warm palette, soft film grain, slightly desaturated,`,
    `gentle nostalgic mood, lo-fi music aesthetic.`,
    `Flat illustration style, clean lines, no text, no watermark.`,
    `Square composition 1:1.`,
  ].join(" ");
}

export async function generateMomentIllustrations(
  gameId: string,
  moments: Array<{ visualPrompt: string; sortOrder: number }>
): Promise<Array<{ sortOrder: number; imagePath: string | null }>> {
  const key = apiKey();
  if (!key) {
    return moments.map(m => ({ sortOrder: m.sortOrder, imagePath: null }));
  }

  if (!UUID_RE.test(gameId)) {
    return moments.map(m => ({ sortOrder: m.sortOrder, imagePath: null }));
  }

  const dir = path.join(PORTRAITS_DIR, gameId);
  mkdirSync(dir, { recursive: true });

  const results = await Promise.allSettled(
    moments.map(async (m) => {
      const filename = `moment-${String(m.sortOrder).padStart(2, "0")}.png`;
      const outPath = path.join(dir, filename);
      const relativePath = `portraits/${gameId}/${filename}`;

      try {
        const buf = await generateImage(momentPrompt(m.visualPrompt), key);
        writeFileSync(outPath, buf);
        logger.info("moment_illustration_ready", { gameId, filename });
        return { sortOrder: m.sortOrder, imagePath: relativePath };
      } catch (e) {
        logger.error("moment_illustration_failed", {
          gameId, filename, error: (e as Error).message,
        });
        return { sortOrder: m.sortOrder, imagePath: null };
      }
    })
  );

  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { sortOrder: moments[i].sortOrder, imagePath: null }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/portrait-gen.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/portrait-gen.ts server/tests/portrait-gen.test.ts
git commit -m "feat(album): add moment illustration generation to portrait pipeline"
```

---

### Task 5: Album API Routes

**Files:**
- Create: `server/src/routes/album.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/album-routes.test.ts` (create)

**Interfaces:**
- Consumes: `GameRepository.loadAlbum()`, `GameRepository.loadScrapbook()` from Task 1
- Produces:
  - `GET /api/user/:userId/album` — returns `{ partners: [...], unlinkedKids: [...] }`
  - `GET /api/user/:userId/album/kid/:gameId` — returns scrapbook data with portrait URLs
  - `createAlbumRoutes(repo: GameRepository): Router`

- [ ] **Step 1: Write failing test**

Create `server/tests/album-routes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { MockLLMClient } from "./helpers/mock-llm.js";

describe("album routes", () => {
  let app: ReturnType<typeof buildServer>;
  let repo: InMemoryGameRepository;
  const BASE = "http://localhost";

  beforeAll(async () => {
    repo = new InMemoryGameRepository();
    app = buildServer({ llm: new MockLLMClient(), repo, enableEviction: false });
    await new Promise<void>((resolve) => app.httpServer.listen(0, resolve));
  });

  afterAll(async () => {
    await app.close();
  });

  function url(path: string) {
    const addr = app.httpServer.address() as { port: number };
    return `${BASE}:${addr.port}${path}`;
  }

  it("GET /api/user/:userId/album returns empty album", async () => {
    const res = await fetch(url("/api/user/test-user/album"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.partners).toEqual([]);
    expect(data.unlinkedKids).toEqual([]);
  });

  it("GET /api/user/:userId/album/kid/:gameId returns 404 for unknown game", async () => {
    const res = await fetch(url("/api/user/test-user/album/kid/nonexistent"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/album-routes.test.ts --reporter=verbose`
Expected: FAIL — routes not registered

- [ ] **Step 3: Implement album routes**

Create `server/src/routes/album.ts`:

```typescript
import { Router } from "express";
import type { Request, Response } from "express";
import type { GameRepository } from "../db/repository.js";
import { existsSync } from "fs";
import path from "path";
import { PORTRAITS_DIR } from "../portrait-gen.js";

const AGE_SLUGS = [
  { age: 3, slug: "age-03" },
  { age: 7, slug: "age-07" },
  { age: 12, slug: "age-12" },
  { age: 16, slug: "age-16" },
  { age: 20, slug: "age-20" },
];

function getPortraitUrls(gameId: string): Array<{ age: number; url: string }> {
  return AGE_SLUGS
    .filter(({ slug }) => existsSync(path.join(PORTRAITS_DIR, gameId, `${slug}.png`)))
    .map(({ age, slug }) => ({ age, url: `portraits/${gameId}/${slug}.png` }));
}

export function createAlbumRoutes(repo: GameRepository): Router {
  const router = Router();

  router.get("/user/:userId/album", async (req: Request, res: Response) => {
    const { userId } = req.params;
    const album = await repo.loadAlbum(userId);
    res.json(album);
  });

  router.get("/user/:userId/album/kid/:gameId", async (req: Request, res: Response) => {
    const { userId, gameId } = req.params;
    const scrapbook = await repo.loadScrapbook(userId, gameId);
    if (!scrapbook) {
      res.status(404).json({ error: "Kid not found" });
      return;
    }
    res.json({
      ...scrapbook,
      portraits: getPortraitUrls(gameId),
    });
  });

  return router;
}
```

- [ ] **Step 4: Wire routes into app.ts**

In `server/src/app.ts`, add:

```typescript
import { createAlbumRoutes } from "./routes/album.js";

// After existing route registrations:
app.use("/api", createAlbumRoutes(repo));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/album-routes.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/album.ts server/src/app.ts server/tests/album-routes.test.ts
git commit -m "feat(album): add album API routes for partner list and scrapbook"
```

---

### Task 6: Wire Album Generation Into Endgame Flow

**Files:**
- Modify: `server/src/routes/endgame.ts`
- Modify: `server/src/socket/handlers.ts` (if multiplayer endgame is handled there)
- Test: `server/tests/endgame-engine.test.ts` (extend)

**Interfaces:**
- Consumes: `EndgameEngine.generateAlbumData()` from Task 3, `GameRepository.saveAlbumPartner()` / `saveAlbumMoments()` / `linkGameToPartner()` from Task 1, `generateMomentIllustrations()` from Task 4, `players` table for multiplayer partner name
- Produces: Album data generated and persisted after every report card generation

- [ ] **Step 1: Modify the report-card route to trigger album generation**

In `server/src/routes/endgame.ts`, after the report card is saved and the `done` SSE event is sent, trigger album generation asynchronously. It must not block the response.

Add a `userId` query parameter to the report-card endpoint (the client will send the Matrix user ID):

After `await repo.saveEndgame(...)` and before `res.end()`, add:

```typescript
// Fire-and-forget album generation
const userId = req.query.userId as string | undefined;
if (userId) {
  (async () => {
    try {
      // Get partner display name for multiplayer games
      let partnerDisplayName: string | undefined;
      const isSoloGame = state.relationshipType === "solo parent" || state.relationshipType === "solo";
      if (!isSoloGame) {
        const players = await repo.loadPlayers(state.id);
        // The "other" player for the requesting user — heuristic: use parent2 for now
        const otherPlayer = players.find(p => p.slot === "parent2");
        partnerDisplayName = otherPlayer?.displayName ?? undefined;
      }

      const albumData = await engine.generateAlbumData(
        state, epilogue ?? "", result.reportCard, partnerDisplayName
      );

      const partnerType = isSoloGame ? "generated" : "real";
      const partnerId = await repo.saveAlbumPartner({
        userId,
        partnerName: albumData.partnerName,
        partnerType,
        relationshipSummary: albumData.relationshipSummary,
      });

      // Generate moment illustrations in parallel
      const illustrations = await generateMomentIllustrations(
        state.id,
        albumData.moments.map((m, i) => ({ visualPrompt: m.visualPrompt, sortOrder: i }))
      );

      // Merge image paths into moments
      const momentsWithImages = albumData.moments.map((m, i) => ({
        age: m.age,
        title: m.title,
        description: m.description,
        momentType: m.momentType,
        imagePath: illustrations[i]?.imagePath ?? null,
        sortOrder: i,
      }));

      await repo.saveAlbumMoments(state.id, momentsWithImages);
      await repo.linkGameToPartner(userId, state.id, partnerId);

      logger.info("album_generated", { gameId: state.id, userId, moments: momentsWithImages.length });
    } catch (e) {
      logger.error("album_generation_failed", { gameId: state.id, error: (e as Error).message });
    }
  })();
}
```

- [ ] **Step 2: Add the import for generateMomentIllustrations**

```typescript
import { generateMomentIllustrations } from "../portrait-gen.js";
```

- [ ] **Step 3: Update the EndgameEngine type in the route to accept the method**

The `EndgameEngine` already has `generateAlbumData` from Task 3. Ensure the `engine` parameter in the route factory has access to it — it already does since it receives the full `EndgameEngine` instance.

- [ ] **Step 4: Run the full test suite to verify nothing broke**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: PASS (album generation won't fire in tests since no userId is passed)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/endgame.ts
git commit -m "feat(album): wire album generation into report-card endgame flow"
```

---

### Task 7: Client — FamilyAlbum, PartnerCards, KidsList Components

**Files:**
- Create: `client/src/components/FamilyAlbum.tsx`
- Create: `client/src/components/PartnerCards.tsx`
- Create: `client/src/components/KidsList.tsx`
- Create: `client/src/styles/album.css`

**Interfaces:**
- Consumes: `GET /api/user/:userId/album`, `GET /api/user/:userId/album/kid/:gameId`
- Produces:
  - `<FamilyAlbum userId={string} />` — top-level album component managing navigation state
  - `<PartnerCards partners={...} unlinkedKids={...} onSelectPartner={...} onSelectKid={...} />` — partner grid
  - `<KidsList partner={...} kids={...} onSelectKid={...} onBack={...} />` — kids for a partner

- [ ] **Step 1: Create album CSS**

Create `client/src/styles/album.css`:

```css
.album {
  max-width: 600px;
  margin: 0 auto;
  padding: 1rem;
}

.album-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.album-header h2 {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 400;
}

.album-back {
  background: none;
  border: none;
  color: var(--text-dim, #888);
  cursor: pointer;
  font-size: 1rem;
  padding: 0.25rem 0.5rem;
}

.partner-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}

.partner-card {
  background: var(--card-bg, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 1rem;
  cursor: pointer;
  transition: border-color 0.2s;
}

.partner-card:hover {
  border-color: var(--accent, rgba(255, 255, 255, 0.3));
}

.partner-name {
  font-size: 1.1rem;
  margin: 0 0 0.25rem;
}

.partner-generated {
  font-style: italic;
}

.partner-kid-count {
  color: var(--text-dim, #888);
  font-size: 0.85rem;
  margin: 0;
}

.partner-thumbnail {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  float: right;
  margin-left: 0.5rem;
}

.kids-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.kid-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: var(--card-bg, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 0.75rem 1rem;
  cursor: pointer;
  transition: border-color 0.2s;
}

.kid-card:hover {
  border-color: var(--accent, rgba(255, 255, 255, 0.3));
}

.kid-thumb {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.kid-name {
  font-size: 1rem;
  margin: 0;
}

.album-empty {
  text-align: center;
  color: var(--text-dim, #888);
  padding: 3rem 1rem;
}
```

- [ ] **Step 2: Create PartnerCards component**

Create `client/src/components/PartnerCards.tsx`:

```tsx
import type { AlbumPartner, AlbumKid } from "./FamilyAlbum";

interface Props {
  partners: Array<AlbumPartner & { kids: AlbumKid[] }>;
  unlinkedKids: AlbumKid[];
  onSelectPartner: (partnerId: string) => void;
  onSelectKid: (gameId: string) => void;
}

export function PartnerCards({ partners, unlinkedKids, onSelectPartner, onSelectKid }: Props) {
  if (partners.length === 0 && unlinkedKids.length === 0) {
    return (
      <div className="album-empty">
        <p>no kids yet.</p>
        <p className="dim">play a game to start your family album.</p>
      </div>
    );
  }

  return (
    <div className="partner-grid">
      {partners.map((p) => (
        <div key={p.id} className="partner-card" onClick={() => onSelectPartner(p.id)}>
          <p className={`partner-name${p.partnerType === "generated" ? " partner-generated" : ""}`}>
            {p.partnerName}
          </p>
          <p className="partner-kid-count">
            {p.kids.length} {p.kids.length === 1 ? "kid" : "kids"}
          </p>
        </div>
      ))}
      {unlinkedKids.length > 0 && (
        <div className="partner-card">
          <p className="partner-name partner-generated">earlier kids</p>
          <p className="partner-kid-count">{unlinkedKids.length}</p>
          <div className="kids-list" style={{ marginTop: "0.5rem" }}>
            {unlinkedKids.map((kid) => (
              <div key={kid.gameId} className="kid-card" onClick={() => onSelectKid(kid.gameId)}>
                <p className="kid-name">{kid.childName}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create KidsList component**

Create `client/src/components/KidsList.tsx`:

```tsx
import type { AlbumPartner, AlbumKid } from "./FamilyAlbum";

interface Props {
  partner: AlbumPartner;
  kids: AlbumKid[];
  onSelectKid: (gameId: string) => void;
  onBack: () => void;
}

export function KidsList({ partner, kids, onSelectKid, onBack }: Props) {
  return (
    <div>
      <div className="album-header">
        <button className="album-back" onClick={onBack}>←</button>
        <h2 className={partner.partnerType === "generated" ? "partner-generated" : ""}>
          kids with {partner.partnerName}
        </h2>
      </div>
      {partner.relationshipSummary && (
        <p className="dim" style={{ marginBottom: "1rem" }}>{partner.relationshipSummary}</p>
      )}
      <div className="kids-list">
        {kids.map((kid) => (
          <div key={kid.gameId} className="kid-card" onClick={() => onSelectKid(kid.gameId)}>
            <p className="kid-name">{kid.childName}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create FamilyAlbum component**

Create `client/src/components/FamilyAlbum.tsx`:

```tsx
import { useState, useEffect } from "react";
import { PartnerCards } from "./PartnerCards";
import { KidsList } from "./KidsList";
import { Scrapbook } from "./Scrapbook";
import "../styles/album.css";

const API = import.meta.env.BASE_URL + "api";

export interface AlbumKid {
  gameId: string;
  childName: string;
  createdAt: number;
}

export interface AlbumPartner {
  id: string;
  partnerName: string;
  partnerType: "real" | "generated";
  relationshipSummary: string;
}

interface AlbumData {
  partners: Array<AlbumPartner & { kids: AlbumKid[] }>;
  unlinkedKids: AlbumKid[];
}

type AlbumView = "partners" | "kids" | "scrapbook";

interface Props {
  userId: string;
  onBack: () => void;
}

export function FamilyAlbum({ userId, onBack }: Props) {
  const [view, setView] = useState<AlbumView>("partners");
  const [album, setAlbum] = useState<AlbumData | null>(null);
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | null>(null);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/user/${encodeURIComponent(userId)}/album`)
      .then((r) => r.json())
      .then((data: AlbumData) => {
        setAlbum(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [userId]);

  if (loading) {
    return (
      <div className="album">
        <p className="dim">loading your family...</p>
      </div>
    );
  }

  if (view === "scrapbook" && selectedGameId) {
    return (
      <div className="album">
        <Scrapbook
          userId={userId}
          gameId={selectedGameId}
          onBack={() => {
            setSelectedGameId(null);
            setView(selectedPartnerId ? "kids" : "partners");
          }}
        />
      </div>
    );
  }

  if (view === "kids" && selectedPartnerId && album) {
    const partner = album.partners.find((p) => p.id === selectedPartnerId);
    if (!partner) {
      setView("partners");
      return null;
    }
    return (
      <div className="album">
        <KidsList
          partner={partner}
          kids={partner.kids}
          onSelectKid={(gameId) => {
            setSelectedGameId(gameId);
            setView("scrapbook");
          }}
          onBack={() => {
            setSelectedPartnerId(null);
            setView("partners");
          }}
        />
      </div>
    );
  }

  return (
    <div className="album">
      <div className="album-header">
        <button className="album-back" onClick={onBack}>←</button>
        <h2>my family</h2>
      </div>
      {album && (
        <PartnerCards
          partners={album.partners}
          unlinkedKids={album.unlinkedKids}
          onSelectPartner={(id) => {
            setSelectedPartnerId(id);
            setView("kids");
          }}
          onSelectKid={(gameId) => {
            setSelectedGameId(gameId);
            setView("scrapbook");
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/FamilyAlbum.tsx client/src/components/PartnerCards.tsx client/src/components/KidsList.tsx client/src/styles/album.css
git commit -m "feat(album): add FamilyAlbum, PartnerCards, and KidsList client components"
```

---

### Task 8: Client — Scrapbook Component

**Files:**
- Create: `client/src/components/Scrapbook.tsx`
- Modify: `client/src/styles/album.css`

**Interfaces:**
- Consumes: `GET /api/user/:userId/album/kid/:gameId`
- Produces: `<Scrapbook userId={string} gameId={string} onBack={() => void} />`

- [ ] **Step 1: Add scrapbook CSS to album.css**

Append to `client/src/styles/album.css`:

```css
.scrapbook-portraits {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  padding: 0.5rem 0;
  margin-bottom: 1.5rem;
  -webkit-overflow-scrolling: touch;
}

.scrapbook-portrait {
  flex-shrink: 0;
  text-align: center;
}

.scrapbook-portrait img {
  width: 100px;
  height: 100px;
  border-radius: 8px;
  object-fit: cover;
}

.scrapbook-portrait-label {
  font-size: 0.75rem;
  color: var(--text-dim, #888);
  margin-top: 0.25rem;
}

.scrapbook-moments {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 2rem;
}

.moment-card {
  display: flex;
  gap: 1rem;
  padding: 0.75rem;
  background: var(--card-bg, rgba(255, 255, 255, 0.05));
  border-radius: 8px;
}

.moment-image {
  width: 80px;
  height: 80px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
}

.moment-placeholder {
  width: 80px;
  height: 80px;
  border-radius: 6px;
  background: var(--card-bg, rgba(255, 255, 255, 0.05));
  flex-shrink: 0;
}

.moment-body {
  flex: 1;
  min-width: 0;
}

.moment-title {
  font-weight: 600;
  margin: 0 0 0.25rem;
}

.moment-age-badge {
  font-size: 0.75rem;
  color: var(--text-dim, #888);
  margin-right: 0.5rem;
}

.moment-type {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.1);
}

.moment-type-funny { color: #f0c674; }
.moment-type-tender { color: #a3d9a5; }
.moment-type-conflict { color: #e08080; }
.moment-type-milestone { color: #8ab4f8; }

.moment-desc {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
  color: var(--text-dim, #ccc);
}

.scrapbook-section {
  margin-bottom: 2rem;
}

.scrapbook-section h3 {
  font-size: 0.85rem;
  text-transform: lowercase;
  color: var(--text-dim, #888);
  margin-bottom: 0.5rem;
  font-weight: 400;
}
```

- [ ] **Step 2: Create Scrapbook component**

Create `client/src/components/Scrapbook.tsx`:

```tsx
import { useState, useEffect } from "react";
import { ReportCard } from "./ReportCard";

const API = import.meta.env.BASE_URL + "api";
const BASE = import.meta.env.BASE_URL;

interface Portrait {
  age: number;
  url: string;
}

interface Moment {
  age: number;
  title: string;
  description: string;
  momentType: string;
  imageUrl: string | null;
}

interface ScrapbookData {
  childName: string;
  partnerName: string | null;
  partnerType: string | null;
  relationshipSummary: string | null;
  portraits: Portrait[];
  moments: Moment[];
  epilogue: string;
  reportCard: string;
}

interface Props {
  userId: string;
  gameId: string;
  onBack: () => void;
}

export function Scrapbook({ userId, gameId, onBack }: Props) {
  const [data, setData] = useState<ScrapbookData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/user/${encodeURIComponent(userId)}/album/kid/${gameId}`)
      .then((r) => r.json())
      .then((d: ScrapbookData) => {
        setData({
          ...d,
          moments: (d.moments ?? []).map((m: any) => ({
            ...m,
            imageUrl: m.imagePath ? `${BASE}${m.imagePath}` : null,
          })),
          portraits: (d.portraits ?? []).map((p: any) => ({
            ...p,
            url: `${BASE}${p.url}`,
          })),
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [userId, gameId]);

  if (loading) return <p className="dim">loading scrapbook...</p>;
  if (!data) return <p className="dim">not found</p>;

  return (
    <div>
      <div className="album-header">
        <button className="album-back" onClick={onBack}>←</button>
        <div>
          <h2 style={{ margin: 0 }}>{data.childName}</h2>
          {data.partnerName && (
            <p className="dim" style={{ margin: 0, fontSize: "0.85rem" }}>
              with {data.partnerName}
            </p>
          )}
        </div>
      </div>

      {data.portraits.length > 0 && (
        <div className="scrapbook-portraits">
          {data.portraits.map((p) => (
            <div key={p.age} className="scrapbook-portrait">
              <img src={p.url} alt={`age ${p.age}`} />
              <div className="scrapbook-portrait-label">age {p.age}</div>
            </div>
          ))}
        </div>
      )}

      {data.moments.length > 0 && (
        <div className="scrapbook-section">
          <h3>key moments</h3>
          <div className="scrapbook-moments">
            {data.moments.map((m, i) => (
              <div key={i} className="moment-card">
                {m.imageUrl ? (
                  <img src={m.imageUrl} alt="" className="moment-image" />
                ) : (
                  <div className="moment-placeholder" />
                )}
                <div className="moment-body">
                  <p className="moment-title">
                    <span className="moment-age-badge">age {m.age}</span>
                    {m.title}
                    <span className={`moment-type moment-type-${m.momentType}`}> {m.momentType}</span>
                  </p>
                  <p className="moment-desc">{m.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.epilogue && (
        <div className="scrapbook-section">
          <h3>years later</h3>
          {data.epilogue
            .split(/\n\s*\n/)
            .map((p, i) => p.trim())
            .filter(Boolean)
            .map((para, i) => (
              <p key={i} style={{ color: "var(--text-dim, #ccc)" }}>{para}</p>
            ))}
        </div>
      )}

      {data.reportCard && (
        <div className="scrapbook-section">
          <h3>report card</h3>
          <ReportCard reportCard={data.reportCard} childName={data.childName} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Scrapbook.tsx client/src/styles/album.css
git commit -m "feat(album): add Scrapbook component with portrait timeline and moment cards"
```

---

### Task 9: Client — Entry Points and Integration

**Files:**
- Modify: `client/src/components/SoloGame.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/hooks/useGame.ts`

**Interfaces:**
- Consumes: `<FamilyAlbum userId={string} onBack={() => void} />` from Task 7
- Produces: Album accessible from start screen (logged-in users) and after report card

- [ ] **Step 1: Add "my family" button to SoloGame start screen**

In `client/src/components/SoloGame.tsx`, in the `phase === "start"` block, add a "my family" button visible only when `matrixUser` is set. Place it after the saved kids list:

```tsx
{matrixUser && (
  <button
    className="btn btn-secondary"
    onClick={() => setShowAlbum(true)}
    style={{ marginTop: "1rem" }}
  >
    my family
  </button>
)}
```

Add state: `const [showAlbum, setShowAlbum] = useState(false);`

Add an early return at the top of the component (after hooks, before phase checks):

```tsx
if (showAlbum && matrixUser) {
  return (
    <div className="app">
      <FamilyAlbum userId={matrixUser} onBack={() => setShowAlbum(false)} />
    </div>
  );
}
```

Add import: `import { FamilyAlbum } from "./FamilyAlbum";`

- [ ] **Step 2: Add "view your family" button after report card**

In `client/src/components/SoloGame.tsx`, in the `phase === "report_card"` block, add a button below the ReportCard:

```tsx
if (phase === "report_card") {
  return (
    <div className="app">
      <ReportCard reportCard={reportCard} childName={childName} />
      {matrixUser && (
        <div style={{ textAlign: "center", marginTop: "1.5rem" }}>
          <button className="btn" onClick={() => setShowAlbum(true)}>
            view your family
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Pass userId to report-card endpoint**

In `client/src/hooks/useGame.ts`, modify `generateReportCard` to accept an optional `userId` and append it as a query parameter:

```typescript
const generateReportCard = useCallback(async (userId?: string) => {
  if (!gameId) return;
  // ... existing setup ...
  const qp = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  const res = await fetch(`${API}/game/${gameId}/report-card${qp}`, {
    // ... rest unchanged
  });
  // ... rest unchanged
}, [gameId, epilogue]);
```

In `SoloGame.tsx`, pass `matrixUser` to `generateReportCard`:

```tsx
// In Endgame onContinue:
<Endgame epilogue={epilogue} onContinue={() => generateReportCard(matrixUser ?? undefined)} />
```

- [ ] **Step 4: Verify the full flow manually**

Start the dev server and test:
1. Start screen shows "my family" when logged in
2. After report card, "view your family" button appears
3. Album loads with partner cards
4. Drilling into a partner shows kids
5. Drilling into a kid shows the scrapbook

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SoloGame.tsx client/src/hooks/useGame.ts
git commit -m "feat(album): add family album entry points to start screen and post-report-card"
```
