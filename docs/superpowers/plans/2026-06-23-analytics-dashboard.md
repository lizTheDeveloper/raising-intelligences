# Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin dashboard that shows game completion rates, per-game detail, and game health — answering "are people completing games at all" before investing in the encounters feature.

**Architecture:** Separate `AdminQueries` interface for read-only analytics queries, with Postgres and in-memory implementations. Admin API routes behind Bearer token auth. Lightweight admin UI in the same SPA, activated by URL path. Umami handles funnel/trend analytics; the custom dashboard covers game-level detail that Umami can't see.

**Tech Stack:** Express routes, raw SQL (via existing `query()` from pool.ts), React components, Umami client-side tracking, Vitest.

## Global Constraints

- **Cost views deferred.** The spec's LLM cost columns/charts depend on an `llm_usage` table that does not exist. The `onUsage` callback in `index.ts` only logs — it doesn't persist to Postgres and carries no `gameId`. Threading cost data through the LLM call stack is a separate project. This plan builds everything EXCEPT cost-related UI. Cost placeholders appear as "—" with a tooltip explaining the feature is coming.
- No client-side router — admin pages use state-based navigation within `AdminApp`.
- App served under `/raising-intelligences/` in production; admin URL is `/raising-intelligences/admin`.
- "Abandoned" = game has no endgame row AND `games.updated_at` is older than threshold (default 7 days). Do NOT use `lastActivityAt` (in-memory only, not persisted).
- Player info shows `display_name` from the `players` table (Pg) or `user_id` from `user_games`. There are no email addresses.
- Admin dashboard requires Postgres. In no-DB mode, admin routes return 503.
- Existing Umami events to keep as-is: `game_started`, `event_intro_viewed`, `conversation_started`, `conversation_ended`, `epilogue_reached`, `game_completed`. Only add genuinely new events (`player_joined`, `sidebar_used`).
- `game_abandoned` (server-side, needs a cron or batch check) and `report_shared` (depends on unbuilt share_token feature) are out of scope for this plan.

---

### Task 1: Admin Data Layer — Types, Interface, Implementations, Tests

**Files:**
- Create: `server/src/db/admin-queries.ts`
- Create: `server/src/db/migrations/005-admin-indexes.sql`
- Test: `server/tests/admin-queries.test.ts`

**Interfaces:**
- Consumes: `query()` from `server/src/db/pool.ts`
- Produces: `AdminQueries` interface with `getOverview()`, `listGames()`, `getGameDetail()`. Types: `OverviewStats`, `GameSummary`, `GameDetail`, `ListGamesOptions`, `EventDetail`, `MessageCounts`. `PgAdminQueries` class. `InMemoryAdminQueries` class with `addGame()`, `addPlayer()`, `addEvent()`, `addMessage()`, `addSnapshot()`, `addEndgame()` populate methods.

- [ ] **Step 1: Write the failing test for overview stats**

```typescript
// server/tests/admin-queries.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";

describe("AdminQueries", () => {
  let aq: InMemoryAdminQueries;

  beforeEach(() => {
    aq = new InMemoryAdminQueries();
  });

  describe("getOverview", () => {
    it("returns zeroes when no games exist", async () => {
      const stats = await aq.getOverview();
      expect(stats).toEqual({
        totalGames: 0,
        activeGames: 0,
        completedGames: 0,
        abandonedGames: 0,
      });
    });

    it("counts active, completed, and abandoned games", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

      aq.addGame({
        id: "active-1",
        childName: "Luna",
        phase: "family_chat",
        currentEventNumber: 3,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: now,
        updatedAt: now,
      });

      aq.addGame({
        id: "completed-1",
        childName: "Max",
        phase: "ended",
        currentEventNumber: 10,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: oldDate,
        updatedAt: oldDate,
      });
      aq.addEndgame("completed-1", { epilogue: "grew up", reportCard: "# Max" });

      aq.addGame({
        id: "abandoned-1",
        childName: "Zoe",
        phase: "debrief",
        currentEventNumber: 5,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: oldDate,
        updatedAt: oldDate,
      });

      const stats = await aq.getOverview();
      expect(stats.totalGames).toBe(3);
      expect(stats.activeGames).toBe(1);
      expect(stats.completedGames).toBe(1);
      expect(stats.abandonedGames).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/admin-queries.test.ts`
Expected: FAIL — module `../src/db/admin-queries.js` not found.

- [ ] **Step 3: Write the types and InMemoryAdminQueries**

```typescript
// server/src/db/admin-queries.ts
import { query } from "./pool.js";

const ABANDONED_THRESHOLD_DAYS = 7;

export interface OverviewStats {
  totalGames: number;
  activeGames: number;
  completedGames: number;
  abandonedGames: number;
}

export interface GameSummary {
  id: string;
  childName: string;
  phase: string;
  currentEventNumber: number;
  totalEvents: number;
  createdAt: string;
  updatedAt: string;
  hasEndgame: boolean;
  players: { slot: string; displayName: string | null }[];
}

export interface ListGamesOptions {
  status?: "active" | "completed" | "abandoned";
  limit?: number;
  offset?: number;
}

export interface EventDetail {
  eventNumber: number;
  age: number;
  description: string;
  setting: string;
  trigger: string;
  createdAt: string;
}

export interface MessageCounts {
  eventNumber: number;
  parent1: number;
  parent2: number;
  kid: number;
}

export interface GameDetail extends GameSummary {
  relationshipType: string;
  identityDocument: string;
  events: EventDetail[];
  messageCounts: MessageCounts[];
  identitySnapshots: { eventNumber: number; document: string }[];
  sidebarUsed: { parent1: boolean; parent2: boolean };
  endgame: { epilogue: string; reportCard: string } | null;
}

export interface AdminQueries {
  getOverview(abandonedThresholdDays?: number): Promise<OverviewStats>;
  listGames(opts?: ListGamesOptions): Promise<{ games: GameSummary[]; total: number }>;
  getGameDetail(gameId: string): Promise<GameDetail | null>;
}

// ── In-Memory Implementation (tests / no-DB mode) ──────────────────────

interface StoredGame {
  id: string;
  childName: string;
  phase: string;
  currentEventNumber: number;
  totalEvents: number;
  relationshipType: string;
  identityDocument: string;
  sidebarUsedParent1: boolean;
  sidebarUsedParent2: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredPlayer {
  slot: string;
  displayName: string | null;
}

interface StoredEvent {
  eventNumber: number;
  age: number;
  description: string;
  setting: string;
  trigger: string;
  createdAt: Date;
}

interface StoredMessage {
  sender: string;
  eventNumber: number;
}

export class InMemoryAdminQueries implements AdminQueries {
  private games = new Map<string, StoredGame>();
  private players = new Map<string, StoredPlayer[]>();
  private events = new Map<string, StoredEvent[]>();
  private messages = new Map<string, StoredMessage[]>();
  private snapshots = new Map<string, { eventNumber: number; document: string }[]>();
  private endgames = new Map<string, { epilogue: string; reportCard: string }>();

  addGame(game: StoredGame): void {
    this.games.set(game.id, game);
  }

  addPlayer(gameId: string, player: StoredPlayer): void {
    const list = this.players.get(gameId) ?? [];
    list.push(player);
    this.players.set(gameId, list);
  }

  addEvent(gameId: string, event: StoredEvent): void {
    const list = this.events.get(gameId) ?? [];
    list.push(event);
    this.events.set(gameId, list);
  }

  addMessage(gameId: string, msg: StoredMessage): void {
    const list = this.messages.get(gameId) ?? [];
    list.push(msg);
    this.messages.set(gameId, list);
  }

  addSnapshot(gameId: string, snapshot: { eventNumber: number; document: string }): void {
    const list = this.snapshots.get(gameId) ?? [];
    list.push(snapshot);
    this.snapshots.set(gameId, list);
  }

  addEndgame(gameId: string, endgame: { epilogue: string; reportCard: string }): void {
    this.endgames.set(gameId, endgame);
  }

  async getOverview(abandonedThresholdDays = ABANDONED_THRESHOLD_DAYS): Promise<OverviewStats> {
    const now = Date.now();
    const threshold = abandonedThresholdDays * 24 * 60 * 60 * 1000;
    let active = 0;
    let completed = 0;
    let abandoned = 0;

    for (const [id, game] of this.games) {
      if (this.endgames.has(id)) {
        completed++;
      } else if (now - game.updatedAt.getTime() > threshold) {
        abandoned++;
      } else {
        active++;
      }
    }

    return {
      totalGames: this.games.size,
      activeGames: active,
      completedGames: completed,
      abandonedGames: abandoned,
    };
  }

  async listGames(opts: ListGamesOptions = {}): Promise<{ games: GameSummary[]; total: number }> {
    const { status, limit = 50, offset = 0 } = opts;
    const now = Date.now();
    const threshold = ABANDONED_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    let entries = [...this.games.values()];

    if (status) {
      entries = entries.filter((g) => {
        const hasEndgame = this.endgames.has(g.id);
        const isOld = now - g.updatedAt.getTime() > threshold;
        if (status === "completed") return hasEndgame;
        if (status === "abandoned") return !hasEndgame && isOld;
        return !hasEndgame && !isOld;
      });
    }

    entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const total = entries.length;
    const page = entries.slice(offset, offset + limit);

    return {
      total,
      games: page.map((g) => ({
        id: g.id,
        childName: g.childName,
        phase: g.phase,
        currentEventNumber: g.currentEventNumber,
        totalEvents: g.totalEvents,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        hasEndgame: this.endgames.has(g.id),
        players: this.players.get(g.id) ?? [],
      })),
    };
  }

  async getGameDetail(gameId: string): Promise<GameDetail | null> {
    const game = this.games.get(gameId);
    if (!game) return null;

    const events = (this.events.get(gameId) ?? [])
      .sort((a, b) => a.eventNumber - b.eventNumber)
      .map((e) => ({
        eventNumber: e.eventNumber,
        age: e.age,
        description: e.description,
        setting: e.setting,
        trigger: e.trigger,
        createdAt: e.createdAt.toISOString(),
      }));

    const msgs = this.messages.get(gameId) ?? [];
    const countsByEvent = new Map<number, { parent1: number; parent2: number; kid: number }>();
    for (const m of msgs) {
      const c = countsByEvent.get(m.eventNumber) ?? { parent1: 0, parent2: 0, kid: 0 };
      if (m.sender === "parent1") c.parent1++;
      else if (m.sender === "parent2") c.parent2++;
      else if (m.sender === "kid") c.kid++;
      countsByEvent.set(m.eventNumber, c);
    }
    const messageCounts = [...countsByEvent.entries()]
      .sort(([a], [b]) => a - b)
      .map(([eventNumber, counts]) => ({ eventNumber, ...counts }));

    return {
      id: game.id,
      childName: game.childName,
      phase: game.phase,
      currentEventNumber: game.currentEventNumber,
      totalEvents: game.totalEvents,
      createdAt: game.createdAt.toISOString(),
      updatedAt: game.updatedAt.toISOString(),
      hasEndgame: this.endgames.has(gameId),
      players: this.players.get(gameId) ?? [],
      relationshipType: game.relationshipType,
      identityDocument: game.identityDocument,
      events,
      messageCounts,
      identitySnapshots: (this.snapshots.get(gameId) ?? []).sort(
        (a, b) => a.eventNumber - b.eventNumber
      ),
      sidebarUsed: {
        parent1: game.sidebarUsedParent1,
        parent2: game.sidebarUsedParent2,
      },
      endgame: this.endgames.get(gameId) ?? null,
    };
  }
}

// ── Postgres Implementation ────────────────────────────────────────────

export class PgAdminQueries implements AdminQueries {
  async getOverview(abandonedThresholdDays = ABANDONED_THRESHOLD_DAYS): Promise<OverviewStats> {
    const res = await query<{
      total: string;
      active: string;
      completed: string;
      abandoned: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (
           WHERE e.game_id IS NULL
             AND g.updated_at >= now() - make_interval(days => $1)
         )::text AS active,
         COUNT(*) FILTER (WHERE e.game_id IS NOT NULL)::text AS completed,
         COUNT(*) FILTER (
           WHERE e.game_id IS NULL
             AND g.updated_at < now() - make_interval(days => $1)
         )::text AS abandoned
       FROM games g
       LEFT JOIN endgames e ON e.game_id = g.id`,
      [abandonedThresholdDays]
    );
    const row = res.rows[0];
    return {
      totalGames: parseInt(row.total, 10),
      activeGames: parseInt(row.active, 10),
      completedGames: parseInt(row.completed, 10),
      abandonedGames: parseInt(row.abandoned, 10),
    };
  }

  async listGames(opts: ListGamesOptions = {}): Promise<{ games: GameSummary[]; total: number }> {
    const { status, limit = 50, offset = 0 } = opts;

    let whereClause = "";
    const params: unknown[] = [];
    let paramIdx = 1;

    if (status === "completed") {
      whereClause = "WHERE e.game_id IS NOT NULL";
    } else if (status === "abandoned") {
      whereClause = `WHERE e.game_id IS NULL AND g.updated_at < now() - interval '${ABANDONED_THRESHOLD_DAYS} days'`;
    } else if (status === "active") {
      whereClause = `WHERE e.game_id IS NULL AND g.updated_at >= now() - interval '${ABANDONED_THRESHOLD_DAYS} days'`;
    }

    const countRes = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM games g LEFT JOIN endgames e ON e.game_id = g.id
       ${whereClause}`
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const gamesRes = await query<{
      id: string;
      child_name: string;
      phase: string;
      current_event_number: number;
      total_events: number;
      created_at: Date;
      updated_at: Date;
      has_endgame: boolean;
    }>(
      `SELECT
         g.id,
         g.child_name,
         g.phase,
         g.current_event_number,
         g.total_events,
         g.created_at,
         g.updated_at,
         (e.game_id IS NOT NULL) AS has_endgame
       FROM games g
       LEFT JOIN endgames e ON e.game_id = g.id
       ${whereClause}
       ORDER BY g.updated_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    const gameIds = gamesRes.rows.map((r) => r.id);
    let playersByGame = new Map<string, { slot: string; displayName: string | null }[]>();
    if (gameIds.length > 0) {
      const playersRes = await query<{
        game_id: string;
        slot: string;
        display_name: string | null;
      }>(
        `SELECT game_id, slot, display_name
         FROM players WHERE game_id = ANY($1)`,
        [gameIds]
      );
      for (const p of playersRes.rows) {
        const list = playersByGame.get(p.game_id) ?? [];
        list.push({ slot: p.slot, displayName: p.display_name });
        playersByGame.set(p.game_id, list);
      }
    }

    return {
      total,
      games: gamesRes.rows.map((r) => ({
        id: r.id,
        childName: r.child_name,
        phase: r.phase,
        currentEventNumber: r.current_event_number,
        totalEvents: r.total_events,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        hasEndgame: r.has_endgame,
        players: playersByGame.get(r.id) ?? [],
      })),
    };
  }

  async getGameDetail(gameId: string): Promise<GameDetail | null> {
    const gameRes = await query<{
      id: string;
      child_name: string;
      relationship_type: string;
      phase: string;
      current_event_number: number;
      total_events: number;
      identity_document: string;
      sidebar_used_parent1: boolean;
      sidebar_used_parent2: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, child_name, relationship_type, phase,
              current_event_number, total_events, identity_document,
              COALESCE(sidebar_used_parent1, false) AS sidebar_used_parent1,
              COALESCE(sidebar_used_parent2, false) AS sidebar_used_parent2,
              created_at, updated_at
       FROM games WHERE id = $1`,
      [gameId]
    );
    if (gameRes.rows.length === 0) return null;
    const g = gameRes.rows[0];

    const [playersRes, eventsRes, msgsRes, snapshotsRes, endgameRes] = await Promise.all([
      query<{ slot: string; display_name: string | null }>(
        `SELECT slot, display_name FROM players WHERE game_id = $1`,
        [gameId]
      ),
      query<{
        event_number: number; age: number; description: string;
        setting: string; trigger: string; created_at: Date;
      }>(
        `SELECT event_number, age, description, setting, trigger, created_at
         FROM events WHERE game_id = $1 ORDER BY event_number`,
        [gameId]
      ),
      query<{ event_number: number; sender: string }>(
        `SELECT COALESCE(event_number, 0) AS event_number, sender
         FROM messages WHERE game_id = $1`,
        [gameId]
      ),
      query<{ event_number: number; document: string }>(
        `SELECT event_number, document
         FROM identity_snapshots WHERE game_id = $1 ORDER BY event_number`,
        [gameId]
      ),
      query<{ epilogue: string; report_card: string }>(
        `SELECT epilogue, report_card FROM endgames WHERE game_id = $1`,
        [gameId]
      ),
    ]);

    const countsByEvent = new Map<number, { parent1: number; parent2: number; kid: number }>();
    for (const m of msgsRes.rows) {
      const c = countsByEvent.get(m.event_number) ?? { parent1: 0, parent2: 0, kid: 0 };
      if (m.sender === "parent1") c.parent1++;
      else if (m.sender === "parent2") c.parent2++;
      else if (m.sender === "kid") c.kid++;
      countsByEvent.set(m.event_number, c);
    }

    const endgameRow = endgameRes.rows[0];

    return {
      id: g.id,
      childName: g.child_name,
      phase: g.phase,
      currentEventNumber: g.current_event_number,
      totalEvents: g.total_events,
      createdAt: g.created_at.toISOString(),
      updatedAt: g.updated_at.toISOString(),
      hasEndgame: !!endgameRow,
      players: playersRes.rows.map((p) => ({ slot: p.slot, displayName: p.display_name })),
      relationshipType: g.relationship_type,
      identityDocument: g.identity_document,
      events: eventsRes.rows.map((e) => ({
        eventNumber: e.event_number,
        age: e.age,
        description: e.description,
        setting: e.setting,
        trigger: e.trigger,
        createdAt: e.created_at.toISOString(),
      })),
      messageCounts: [...countsByEvent.entries()]
        .sort(([a], [b]) => a - b)
        .map(([eventNumber, counts]) => ({ eventNumber, ...counts })),
      identitySnapshots: snapshotsRes.rows.map((s) => ({
        eventNumber: s.event_number,
        document: s.document,
      })),
      sidebarUsed: {
        parent1: g.sidebar_used_parent1,
        parent2: g.sidebar_used_parent2,
      },
      endgame: endgameRow
        ? { epilogue: endgameRow.epilogue, reportCard: endgameRow.report_card }
        : null,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run tests/admin-queries.test.ts`
Expected: PASS

- [ ] **Step 5: Write tests for listGames and getGameDetail**

Add to `server/tests/admin-queries.test.ts`:

```typescript
  describe("listGames", () => {
    it("returns all games sorted by updatedAt descending", async () => {
      const old = new Date("2026-06-01");
      const recent = new Date("2026-06-20");

      aq.addGame({
        id: "game-old",
        childName: "Old",
        phase: "ended",
        currentEventNumber: 10,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: old,
        updatedAt: old,
      });
      aq.addEndgame("game-old", { epilogue: "done", reportCard: "# Old" });

      aq.addGame({
        id: "game-recent",
        childName: "Recent",
        phase: "family_chat",
        currentEventNumber: 2,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: recent,
        updatedAt: recent,
      });
      aq.addPlayer("game-recent", { slot: "parent1", displayName: "Alice" });

      const result = await aq.listGames();
      expect(result.total).toBe(2);
      expect(result.games[0].id).toBe("game-recent");
      expect(result.games[0].players).toEqual([{ slot: "parent1", displayName: "Alice" }]);
      expect(result.games[1].id).toBe("game-old");
      expect(result.games[1].hasEndgame).toBe(true);
    });

    it("filters by status", async () => {
      const now = new Date();
      aq.addGame({
        id: "active-1",
        childName: "Active",
        phase: "family_chat",
        currentEventNumber: 1,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: now,
        updatedAt: now,
      });
      aq.addGame({
        id: "completed-1",
        childName: "Done",
        phase: "ended",
        currentEventNumber: 10,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: now,
        updatedAt: now,
      });
      aq.addEndgame("completed-1", { epilogue: "done", reportCard: "# Done" });

      const active = await aq.listGames({ status: "active" });
      expect(active.total).toBe(1);
      expect(active.games[0].childName).toBe("Active");

      const completed = await aq.listGames({ status: "completed" });
      expect(completed.total).toBe(1);
      expect(completed.games[0].childName).toBe("Done");
    });

    it("paginates with limit and offset", async () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        aq.addGame({
          id: `game-${i}`,
          childName: `Kid ${i}`,
          phase: "family_chat",
          currentEventNumber: 1,
          totalEvents: 10,
          relationshipType: "co-parents",
          identityDocument: "",
          sidebarUsedParent1: false,
          sidebarUsedParent2: false,
          createdAt: now,
          updatedAt: new Date(now.getTime() + i * 1000),
        });
      }

      const page = await aq.listGames({ limit: 2, offset: 1 });
      expect(page.total).toBe(5);
      expect(page.games).toHaveLength(2);
      expect(page.games[0].id).toBe("game-3");
      expect(page.games[1].id).toBe("game-2");
    });
  });

  describe("getGameDetail", () => {
    it("returns null for unknown game", async () => {
      expect(await aq.getGameDetail("missing")).toBeNull();
    });

    it("returns full game detail with events, messages, snapshots", async () => {
      const now = new Date();
      aq.addGame({
        id: "game-1",
        childName: "Luna",
        phase: "debrief",
        currentEventNumber: 2,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "Core beliefs: the world is safe.",
        sidebarUsedParent1: true,
        sidebarUsedParent2: false,
        createdAt: now,
        updatedAt: now,
      });
      aq.addPlayer("game-1", { slot: "parent1", displayName: "Alice" });
      aq.addEvent("game-1", {
        eventNumber: 1, age: 4, description: "Broke a vase",
        setting: "Living room", trigger: "Accident", createdAt: now,
      });
      aq.addMessage("game-1", { sender: "parent1", eventNumber: 1 });
      aq.addMessage("game-1", { sender: "parent1", eventNumber: 1 });
      aq.addMessage("game-1", { sender: "kid", eventNumber: 1 });
      aq.addSnapshot("game-1", { eventNumber: 1, document: "v1 doc" });

      const detail = await aq.getGameDetail("game-1");
      expect(detail).not.toBeNull();
      expect(detail!.childName).toBe("Luna");
      expect(detail!.events).toHaveLength(1);
      expect(detail!.events[0].age).toBe(4);
      expect(detail!.messageCounts).toEqual([
        { eventNumber: 1, parent1: 2, parent2: 0, kid: 1 },
      ]);
      expect(detail!.identitySnapshots).toEqual([
        { eventNumber: 1, document: "v1 doc" },
      ]);
      expect(detail!.sidebarUsed.parent1).toBe(true);
      expect(detail!.endgame).toBeNull();
    });

    it("includes endgame when completed", async () => {
      const now = new Date();
      aq.addGame({
        id: "game-1",
        childName: "Luna",
        phase: "ended",
        currentEventNumber: 10,
        totalEvents: 10,
        relationshipType: "co-parents",
        identityDocument: "",
        sidebarUsedParent1: false,
        sidebarUsedParent2: false,
        createdAt: now,
        updatedAt: now,
      });
      aq.addEndgame("game-1", { epilogue: "grew up", reportCard: "# Luna" });

      const detail = await aq.getGameDetail("game-1");
      expect(detail!.endgame).toEqual({ epilogue: "grew up", reportCard: "# Luna" });
    });
  });
```

- [ ] **Step 6: Run all admin-queries tests**

Run: `cd server && npx vitest run tests/admin-queries.test.ts`
Expected: PASS

- [ ] **Step 7: Create the admin indexes migration**

```sql
-- server/src/db/migrations/005-admin-indexes.sql
-- Indexes to support admin dashboard queries.
CREATE INDEX IF NOT EXISTS idx_games_phase ON games (phase);
CREATE INDEX IF NOT EXISTS idx_games_updated_at ON games (updated_at);
```

- [ ] **Step 8: Commit**

```bash
git add server/src/db/admin-queries.ts server/src/db/migrations/005-admin-indexes.sql server/tests/admin-queries.test.ts
git commit -m "feat: add admin queries data layer with in-memory and Postgres implementations"
```

---

### Task 2: Admin API Routes, Auth Middleware, and Server Wiring

**Files:**
- Create: `server/src/routes/admin.ts`
- Modify: `server/src/app.ts` (add `adminQueries` to `BuildServerOptions`, wire admin routes)
- Modify: `server/src/index.ts` (construct `PgAdminQueries` when Postgres is available, pass to `buildServer`)
- Modify: `server/tests/helpers/test-server.ts` (create and expose `InMemoryAdminQueries`)
- Test: `server/tests/admin-routes.test.ts`

**Interfaces:**
- Consumes: `AdminQueries` interface and `PgAdminQueries` class from `server/src/db/admin-queries.ts`, `BuildServerOptions` from `server/src/app.ts`
- Produces: Express router mounted at `/api/admin` with `GET /api/admin/overview`, `GET /api/admin/games`, `GET /api/admin/games/:id`. Bearer token auth middleware (`ADMIN_TOKEN` env var). Updated `BuildServerOptions` with `adminQueries?: AdminQueries`. Updated `TestServer` with `adminQueries: InMemoryAdminQueries`. Production wiring in `index.ts`.

- [ ] **Step 1: Write the failing test for admin auth**

```typescript
// server/tests/admin-routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestServer, type TestServer } from "./helpers/test-server.js";

describe("Admin API routes", () => {
  let server: TestServer;

  beforeAll(async () => {
    process.env.ADMIN_TOKEN = "test-admin-secret";
    server = await createTestServer("admin-routes");
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.ADMIN_TOKEN;
  });

  it("rejects requests without auth token", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/overview`);
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong token", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/overview`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns overview stats for authenticated admin", async () => {
    server.adminQueries.addGame({
      id: "g1",
      childName: "Luna",
      phase: "family_chat",
      currentEventNumber: 1,
      totalEvents: 10,
      relationshipType: "co-parents",
      identityDocument: "",
      sidebarUsedParent1: false,
      sidebarUsedParent2: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await fetch(`${server.baseUrl}/api/admin/overview`, {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalGames).toBe(1);
    expect(data.activeGames).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/admin-routes.test.ts`
Expected: FAIL — `adminQueries` not found on TestServer.

- [ ] **Step 3: Create admin routes with auth middleware**

```typescript
// server/src/routes/admin.ts
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AdminQueries } from "../db/admin-queries.js";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    res.status(503).json({ error: "Admin not configured" });
    return;
  }
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${token}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function createAdminRoutes(adminQueries: AdminQueries): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/admin/overview", async (_req: Request, res: Response) => {
    try {
      const stats = await adminQueries.getOverview();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/admin/games", async (req: Request, res: Response) => {
    try {
      const status = req.query.status as "active" | "completed" | "abandoned" | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
      const result = await adminQueries.listGames({ status, limit, offset });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/admin/games/:id", async (req: Request, res: Response) => {
    try {
      const detail = await adminQueries.getGameDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "Game not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
```

- [ ] **Step 4: Wire admin routes into buildServer**

In `server/src/app.ts`, add the import and option:

Add import at top:
```typescript
import { createAdminRoutes } from "./routes/admin.js";
import type { AdminQueries } from "./db/admin-queries.js";
```

Add to `BuildServerOptions`:
```typescript
  /** Read-only analytics queries for the admin dashboard. */
  adminQueries?: AdminQueries;
```

Add route registration after the existing `app.use("/api", ...)` lines (around line 110):
```typescript
  if (options.adminQueries) {
    app.use("/api", createAdminRoutes(options.adminQueries));
  }
```

- [ ] **Step 5: Wire InMemoryAdminQueries into test server**

In `server/tests/helpers/test-server.ts`:

Add import:
```typescript
import { InMemoryAdminQueries } from "../../src/db/admin-queries.js";
```

Add to `TestServer` interface:
```typescript
  adminQueries: InMemoryAdminQueries;
```

In `createTestServer()`, create and pass admin queries:
```typescript
  const adminQueries = new InMemoryAdminQueries();
  const built = buildServer({
    llm: cassette,
    repo: memRepo,
    adminQueries,
    enableEviction: false,
    allowedOrigin: "*",
    socketPath: "/socket.io",
  });
```

Add to the return:
```typescript
  return { ...built, baseUrl, memRepo, adminQueries, cassette, stop };
```

- [ ] **Step 6: Wire PgAdminQueries into the production entry point**

In `server/src/index.ts`, add the import:
```typescript
import { PgAdminQueries } from "./db/admin-queries.js";
```

Inside the `if (usingPostgres)` block (after `repo = new PgGameRepository()`), construct the admin queries:
```typescript
  if (usingPostgres) {
    const { migrate } = await import("./db/migrate.js");
    await migrate();
    repo = new PgGameRepository();
    adminQueries = new PgAdminQueries();
    logger.info("persistence_mode", { mode: "postgres" });
  } else {
    repo = new InMemoryGameRepository();
    logger.info("persistence_mode", { mode: "in-memory", hint: "set DATABASE_URL to enable Postgres" });
  }
```

Declare `adminQueries` before the `if`:
```typescript
  let repo: GameRepository;
  let adminQueries: AdminQueries | undefined;
  const usingPostgres = !!process.env.DATABASE_URL;
```

Add the `AdminQueries` type import:
```typescript
import type { AdminQueries } from "./db/admin-queries.js";
```

Pass `adminQueries` to `buildServer`:
```typescript
  const { httpServer, close } = buildServer({
    llm,
    repo,
    adminQueries,
    serveStatic: process.env.NODE_ENV === "production",
    // ... rest unchanged
  });
```

This ensures admin routes are live in production when Postgres is available, and silently absent in no-DB mode.

- [ ] **Step 7: Run all admin-routes tests**

Run: `cd server && npx vitest run tests/admin-routes.test.ts`
Expected: PASS

- [ ] **Step 8: Add tests for game list and game detail routes**

Add to `server/tests/admin-routes.test.ts`:

```typescript
  it("returns game list with status filter", async () => {
    const now = new Date();
    server.adminQueries.addGame({
      id: "completed-1",
      childName: "Max",
      phase: "ended",
      currentEventNumber: 10,
      totalEvents: 10,
      relationshipType: "co-parents",
      identityDocument: "",
      sidebarUsedParent1: false,
      sidebarUsedParent2: false,
      createdAt: now,
      updatedAt: now,
    });
    server.adminQueries.addEndgame("completed-1", { epilogue: "done", reportCard: "# Max" });

    const res = await fetch(`${server.baseUrl}/api/admin/games?status=completed`, {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.games.length).toBeGreaterThanOrEqual(1);
    expect(data.games.some((g: { id: string }) => g.id === "completed-1")).toBe(true);
  });

  it("returns game detail", async () => {
    const now = new Date();
    server.adminQueries.addGame({
      id: "detail-1",
      childName: "Zoe",
      phase: "family_chat",
      currentEventNumber: 1,
      totalEvents: 10,
      relationshipType: "co-parents",
      identityDocument: "Core beliefs.",
      sidebarUsedParent1: false,
      sidebarUsedParent2: false,
      createdAt: now,
      updatedAt: now,
    });
    server.adminQueries.addEvent("detail-1", {
      eventNumber: 1, age: 4, description: "Broke a vase",
      setting: "Living room", trigger: "Accident", createdAt: now,
    });

    const res = await fetch(`${server.baseUrl}/api/admin/games/detail-1`, {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.childName).toBe("Zoe");
    expect(data.events).toHaveLength(1);
  });

  it("returns 404 for unknown game detail", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/games/nonexistent`, {
      headers: { Authorization: "Bearer test-admin-secret" },
    });
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 9: Run all tests (admin + existing)**

Run: `cd server && npx vitest run tests/admin-routes.test.ts`
Expected: PASS

Run: `cd server && npx vitest run`
Expected: All existing tests still pass.

- [ ] **Step 10: Commit**

```bash
git add server/src/routes/admin.ts server/src/app.ts server/src/index.ts server/tests/helpers/test-server.ts server/tests/admin-routes.test.ts
git commit -m "feat: add admin API routes with Bearer token auth"
```

---

### Task 3: Umami Event Instrumentation

**Files:**
- Modify: `client/src/hooks/useMultiplayer.ts` (add `player_joined` event)
- Modify: `client/src/components/MultiplayerGame.tsx` (add `sidebar_used` event)

**Interfaces:**
- Consumes: `track()` from `client/src/analytics.ts`, `E.JOINED` and `startSidebar` from `useMultiplayer.ts`
- Produces: Two new Umami custom events fired during gameplay: `player_joined` (when socket emits JOINED for a game with a joinGameId), `sidebar_used` (when a player clicks the sidebar button).

- [ ] **Step 1: Add player_joined event to useMultiplayer**

In `client/src/hooks/useMultiplayer.ts`, add the import:

```typescript
import { track } from "../analytics";
```

In the `E.JOINED` handler (around line 84), add the track call after setting state:

```typescript
    socket.on(E.JOINED, (d: { gameId: string; slot: Slot }) => {
      setGameId(d.gameId);
      setSlot(d.slot);
      setInLobby(true);
      track("player_joined", { game_id: d.gameId });
    });
```

- [ ] **Step 2: Add sidebar_used event to MultiplayerGame**

In `client/src/components/MultiplayerGame.tsx`, add the import:

```typescript
import { track } from "../analytics";
```

Find the sidebar button (around line 196, the `onClick={mp.startSidebar}` button). Wrap the click handler to track the event:

```typescript
              <button className="btn btn-secondary" onClick={() => { track("sidebar_used", { game_id: state.gameId ?? "" }); mp.startSidebar(); }} disabled={mp.isStreaming}>
```

Note: Check that `state.gameId` (or equivalent) is available in the component's state. If the game ID isn't in ViewerState, use the `mp.gameId` from the multiplayer hook instead.

- [ ] **Step 3: Verify the app still builds**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/useMultiplayer.ts client/src/components/MultiplayerGame.tsx
git commit -m "feat: add player_joined and sidebar_used Umami events"
```

---

### Task 4: Admin UI — Layout and Overview Page

**Files:**
- Create: `client/src/components/admin/AdminApp.tsx`
- Create: `client/src/components/admin/Overview.tsx`
- Create: `client/src/hooks/useAdminApi.ts`
- Create: `client/src/admin.css`
- Modify: `client/src/App.tsx` (route to AdminApp on admin path)

**Interfaces:**
- Consumes: `GET /api/admin/overview` response shape `OverviewStats` from Task 1
- Produces: `AdminApp` component (top-level admin shell with navigation), `Overview` component, `useAdminApi` hook with `fetchOverview()`, `fetchGames()`, `fetchGameDetail()`.

- [ ] **Step 1: Create the admin API hook**

```typescript
// client/src/hooks/useAdminApi.ts

export interface OverviewStats {
  totalGames: number;
  activeGames: number;
  completedGames: number;
  abandonedGames: number;
}

export interface GameSummary {
  id: string;
  childName: string;
  phase: string;
  currentEventNumber: number;
  totalEvents: number;
  createdAt: string;
  updatedAt: string;
  hasEndgame: boolean;
  players: { slot: string; displayName: string | null }[];
}

export interface GameDetail extends GameSummary {
  relationshipType: string;
  identityDocument: string;
  events: {
    eventNumber: number;
    age: number;
    description: string;
    setting: string;
    trigger: string;
    createdAt: string;
  }[];
  messageCounts: {
    eventNumber: number;
    parent1: number;
    parent2: number;
    kid: number;
  }[];
  identitySnapshots: { eventNumber: number; document: string }[];
  sidebarUsed: { parent1: boolean; parent2: boolean };
  endgame: { epilogue: string; reportCard: string } | null;
}

const BASE = import.meta.env.BASE_URL + "api/admin";

export function useAdminApi(token: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  async function fetchOverview(): Promise<OverviewStats> {
    const res = await fetch(`${BASE}/overview`, { headers });
    if (res.status === 401) throw new Error("Unauthorized");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchGames(opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ games: GameSummary[]; total: number }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const res = await fetch(`${BASE}/games?${params}`, { headers });
    if (res.status === 401) throw new Error("Unauthorized");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchGameDetail(gameId: string): Promise<GameDetail> {
    const res = await fetch(`${BASE}/games/${gameId}`, { headers });
    if (res.status === 401) throw new Error("Unauthorized");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return { fetchOverview, fetchGames, fetchGameDetail };
}
```

- [ ] **Step 2: Create the admin CSS**

```css
/* client/src/admin.css */
.admin-app {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
  font-family: system-ui, -apple-system, sans-serif;
  color: #e0e0e0;
  background: #111;
  min-height: 100vh;
}

.admin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2rem;
  border-bottom: 1px solid #333;
  padding-bottom: 1rem;
}

.admin-header h1 {
  font-size: 1.4rem;
  font-weight: 600;
}

.admin-nav {
  display: flex;
  gap: 0.5rem;
}

.admin-nav button {
  background: none;
  border: 1px solid #444;
  color: #aaa;
  padding: 0.4rem 0.8rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.85rem;
}

.admin-nav button.active {
  background: #2a2a2a;
  color: #fff;
  border-color: #666;
}

.admin-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 1rem;
}

.admin-login input {
  padding: 0.6rem 1rem;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 1rem;
  width: 300px;
}

.admin-login button {
  padding: 0.6rem 1.5rem;
  background: #333;
  border: 1px solid #555;
  border-radius: 4px;
  color: #e0e0e0;
  cursor: pointer;
  font-size: 0.9rem;
}

.admin-login .error {
  color: #f66;
  font-size: 0.85rem;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-card {
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  padding: 1.2rem;
}

.stat-card .label {
  font-size: 0.8rem;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.stat-card .value {
  font-size: 1.8rem;
  font-weight: 700;
  margin-top: 0.3rem;
}

.stat-card .sub {
  font-size: 0.8rem;
  color: #666;
  margin-top: 0.2rem;
}

.admin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.admin-table th {
  text-align: left;
  padding: 0.6rem 0.8rem;
  border-bottom: 2px solid #333;
  color: #888;
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.admin-table td {
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid #222;
}

.admin-table tr:hover td {
  background: #1a1a1a;
}

.admin-table .link {
  color: #7bb3ff;
  cursor: pointer;
  text-decoration: none;
}

.admin-table .link:hover {
  text-decoration: underline;
}

.admin-filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.admin-filters select,
.admin-filters input {
  padding: 0.4rem 0.6rem;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 0.85rem;
}

.pagination {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  align-items: center;
  font-size: 0.85rem;
  color: #888;
}

.pagination button {
  padding: 0.3rem 0.7rem;
  background: #222;
  border: 1px solid #444;
  border-radius: 4px;
  color: #ccc;
  cursor: pointer;
  font-size: 0.8rem;
}

.pagination button:disabled {
  opacity: 0.4;
  cursor: default;
}

.detail-section {
  margin-bottom: 2rem;
}

.detail-section h2 {
  font-size: 1.1rem;
  margin-bottom: 0.8rem;
  color: #ccc;
}

.status-bar {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
  padding: 1rem;
  background: #1a1a1a;
  border-radius: 8px;
  margin-bottom: 1.5rem;
  font-size: 0.9rem;
}

.status-bar .item {
  display: flex;
  flex-direction: column;
}

.status-bar .item .label {
  font-size: 0.7rem;
  color: #888;
  text-transform: uppercase;
}

.identity-diff {
  background: #1a1a1a;
  padding: 1rem;
  border-radius: 6px;
  font-size: 0.85rem;
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #2a2a2a;
}

.back-btn {
  background: none;
  border: none;
  color: #7bb3ff;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0;
  margin-bottom: 1rem;
}

.loading {
  color: #888;
  padding: 2rem;
  text-align: center;
}
```

- [ ] **Step 3: Create the Overview component**

```tsx
// client/src/components/admin/Overview.tsx
import { useEffect, useState } from "react";
import type { OverviewStats } from "../../hooks/useAdminApi";

interface Props {
  fetchOverview: () => Promise<OverviewStats>;
}

export function Overview({ fetchOverview }: Props) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchOverview()
      .then(setStats)
      .catch((e) => setError(e.message));
  }, [fetchOverview]);

  if (error) return <p className="loading">Error: {error}</p>;
  if (!stats) return <p className="loading">Loading...</p>;

  const completionRate =
    stats.completedGames + stats.abandonedGames > 0
      ? Math.round(
          (stats.completedGames / (stats.completedGames + stats.abandonedGames)) * 100
        )
      : 0;

  return (
    <div>
      <h2>Overview</h2>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="label">Total Games</div>
          <div className="value">{stats.totalGames}</div>
        </div>
        <div className="stat-card">
          <div className="label">Active</div>
          <div className="value">{stats.activeGames}</div>
          <div className="sub">in progress now</div>
        </div>
        <div className="stat-card">
          <div className="label">Completed</div>
          <div className="value">{stats.completedGames}</div>
          <div className="sub">{completionRate}% completion rate</div>
        </div>
        <div className="stat-card">
          <div className="label">Abandoned</div>
          <div className="value">{stats.abandonedGames}</div>
          <div className="sub">7+ days idle</div>
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="label">LLM Cost</div>
          <div className="value" style={{ color: "#666" }}>—</div>
          <div className="sub">cost tracking coming soon</div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the AdminApp shell**

```tsx
// client/src/components/admin/AdminApp.tsx
import { useState, useCallback } from "react";
import { useAdminApi } from "../../hooks/useAdminApi";
import { Overview } from "./Overview";
import "../../admin.css";

type Page = "overview" | "games" | "game-detail";

export function AdminApp() {
  const [token, setToken] = useState(sessionStorage.getItem("admin_token") ?? "");
  const [authenticated, setAuthenticated] = useState(!!sessionStorage.getItem("admin_token"));
  const [loginInput, setLoginInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [page, setPage] = useState<Page>("overview");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);

  const api = useAdminApi(token);

  const handleLogin = useCallback(async () => {
    setLoginError("");
    const testToken = loginInput.trim();
    if (!testToken) return;
    const base = import.meta.env.BASE_URL + "api/admin";
    try {
      const res = await fetch(`${base}/overview`, {
        headers: { Authorization: `Bearer ${testToken}` },
      });
      if (!res.ok) throw new Error("Invalid token");
      setToken(testToken);
      sessionStorage.setItem("admin_token", testToken);
      setAuthenticated(true);
    } catch {
      setLoginError("Invalid token");
    }
  }, [loginInput]);

  const navigateToGame = useCallback((gameId: string) => {
    setSelectedGameId(gameId);
    setPage("game-detail");
  }, []);

  if (!authenticated) {
    return (
      <div className="admin-app">
        <div className="admin-login">
          <h1>raising intelligences — admin</h1>
          <input
            type="password"
            placeholder="Admin token"
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
          />
          <button onClick={handleLogin}>Sign in</button>
          {loginError && <p className="error">{loginError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="admin-app">
      <div className="admin-header">
        <h1>raising intelligences — admin</h1>
        <nav className="admin-nav">
          <button
            className={page === "overview" ? "active" : ""}
            onClick={() => setPage("overview")}
          >
            Overview
          </button>
          <button
            className={page === "games" || page === "game-detail" ? "active" : ""}
            onClick={() => setPage("games")}
          >
            Games
          </button>
        </nav>
      </div>
      {page === "overview" && <Overview fetchOverview={api.fetchOverview} />}
      {page === "games" && (
        <p className="loading">Game list — see Task 5</p>
      )}
      {page === "game-detail" && selectedGameId && (
        <p className="loading">Game detail — see Task 6</p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Route to AdminApp from App.tsx**

In `client/src/App.tsx`, add the import at the top:

```typescript
import { AdminApp } from "./components/admin/AdminApp";
```

At the beginning of the `App` function body, before the existing `params` and state declarations, add:

```typescript
  const isAdmin = window.location.pathname.endsWith("/admin") || window.location.pathname.includes("/admin/");
  if (isAdmin) return <AdminApp />;
```

- [ ] **Step 6: Verify the app builds**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 7: Start the dev server and verify admin page loads**

Run: `cd client && npx vite --open` (in a separate terminal, or use the dev script)
Navigate to `http://localhost:5173/admin` in a browser.
Expected: See the admin login screen with token input. The game app at `http://localhost:5173/` should still work normally.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/admin/AdminApp.tsx client/src/components/admin/Overview.tsx client/src/hooks/useAdminApi.ts client/src/admin.css client/src/App.tsx
git commit -m "feat: add admin UI shell with login and overview page"
```

---

### Task 5: Admin UI — Game List Page

**Files:**
- Create: `client/src/components/admin/GameList.tsx`
- Modify: `client/src/components/admin/AdminApp.tsx` (replace placeholder with GameList)

**Interfaces:**
- Consumes: `fetchGames()` from `useAdminApi` hook (returns `{ games: GameSummary[]; total: number }`), `navigateToGame(gameId)` callback from `AdminApp`.
- Produces: `GameList` component with searchable, filterable, paginated table.

- [ ] **Step 1: Create the GameList component**

```tsx
// client/src/components/admin/GameList.tsx
import { useEffect, useState, useCallback } from "react";
import type { GameSummary } from "../../hooks/useAdminApi";

interface Props {
  fetchGames: (opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{ games: GameSummary[]; total: number }>;
  onSelectGame: (gameId: string) => void;
}

const PAGE_SIZE = 25;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusLabel(game: GameSummary): string {
  if (game.hasEndgame) return "completed";
  const idle = Date.now() - new Date(game.updatedAt).getTime();
  if (idle > 7 * 24 * 60 * 60 * 1000) return "abandoned";
  return game.phase;
}

export function GameList({ fetchGames, onSelectGame }: Props) {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchGames({
        status: status || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setGames(result.games);
      setTotal(result.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [fetchGames, status, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    setOffset(0);
  };

  return (
    <div>
      <h2>Games</h2>
      <div className="admin-filters">
        <input
          type="text"
          placeholder="Search by child name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={status} onChange={(e) => handleStatusChange(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="abandoned">Abandoned</option>
        </select>
      </div>

      {error && <p className="loading">Error: {error}</p>}
      {loading && <p className="loading">Loading...</p>}
      {!loading && !error && (() => {
        const filtered = search
          ? games.filter((g) => g.childName.toLowerCase().includes(search.toLowerCase()))
          : games;
        return (
        <>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Child</th>
                <th>Players</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Last Activity</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.id}>
                  <td>
                    <span className="link" onClick={() => onSelectGame(g.id)}>
                      {g.childName}
                    </span>
                  </td>
                  <td>
                    {g.players.length > 0
                      ? g.players.map((p) => p.displayName ?? p.slot).join(", ")
                      : "—"}
                  </td>
                  <td>{statusLabel(g)}</td>
                  <td>
                    {g.currentEventNumber}/{g.totalEvents}
                  </td>
                  <td>{timeAgo(g.updatedAt)}</td>
                  <td>{new Date(g.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {games.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "#666" }}>
                    No games found
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="pagination">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Prev
            </button>
            <span>
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              Next
            </button>
          </div>
        </>
        );
      })()}
    </div>
  );
}
```

- [ ] **Step 2: Wire GameList into AdminApp**

In `client/src/components/admin/AdminApp.tsx`:

Add import:
```typescript
import { GameList } from "./GameList";
```

Replace the games placeholder (`{page === "games" && ...}`) with:

```tsx
      {page === "games" && (
        <GameList fetchGames={api.fetchGames} onSelectGame={navigateToGame} />
      )}
```

- [ ] **Step 3: Verify the app builds**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Start dev server and test the game list page**

Navigate to `http://localhost:5173/admin`, authenticate, click "Games" tab.
Expected: See the game list table (empty if no games in backend). Status filter dropdown should be visible.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/admin/GameList.tsx client/src/components/admin/AdminApp.tsx
git commit -m "feat: add admin game list page with filtering and pagination"
```

---

### Task 6: Admin UI — Game Detail Page

**Files:**
- Create: `client/src/components/admin/GameDetail.tsx`
- Modify: `client/src/components/admin/AdminApp.tsx` (replace placeholder with GameDetail)

**Interfaces:**
- Consumes: `fetchGameDetail(gameId)` from `useAdminApi` hook (returns `GameDetail`), `onBack()` callback to navigate back to game list.
- Produces: `GameDetailView` component showing status bar, event timeline, message counts per event, identity evolution, sidebar usage, and endgame preview.

- [ ] **Step 1: Create the GameDetail component**

```tsx
// client/src/components/admin/GameDetail.tsx
import { useEffect, useState } from "react";
import type { GameDetail } from "../../hooks/useAdminApi";

interface Props {
  gameId: string;
  fetchGameDetail: (gameId: string) => Promise<GameDetail>;
  onBack: () => void;
}

export function GameDetailView({ gameId, fetchGameDetail, onBack }: Props) {
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchGameDetail(gameId)
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [gameId, fetchGameDetail]);

  if (error) return <p className="loading">Error: {error}</p>;
  if (!detail) return <p className="loading">Loading...</p>;

  const duration = Math.round(
    (new Date(detail.updatedAt).getTime() - new Date(detail.createdAt).getTime()) / 60000
  );

  return (
    <div>
      <button className="back-btn" onClick={onBack}>
        &larr; Back to games
      </button>

      <h2>{detail.childName}</h2>

      <div className="status-bar">
        <div className="item">
          <span className="label">Phase</span>
          <span>{detail.phase}</span>
        </div>
        <div className="item">
          <span className="label">Progress</span>
          <span>{detail.currentEventNumber}/{detail.totalEvents} events</span>
        </div>
        <div className="item">
          <span className="label">Duration</span>
          <span>{duration < 60 ? `${duration}m` : `${Math.round(duration / 60)}h`}</span>
        </div>
        <div className="item">
          <span className="label">Type</span>
          <span>{detail.relationshipType}</span>
        </div>
        <div className="item">
          <span className="label">Status</span>
          <span>{detail.hasEndgame ? "Completed" : "In progress"}</span>
        </div>
      </div>

      {detail.players.length > 0 && (
        <div className="detail-section">
          <h2>Players</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Name</th>
              </tr>
            </thead>
            <tbody>
              {detail.players.map((p) => (
                <tr key={p.slot}>
                  <td>{p.slot}</td>
                  <td>{p.displayName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="detail-section">
        <h2>Events</h2>
        {detail.events.length === 0 ? (
          <p style={{ color: "#666" }}>No events yet</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Age</th>
                <th>Description</th>
                <th>P1 Msgs</th>
                <th>P2 Msgs</th>
                <th>Kid Msgs</th>
              </tr>
            </thead>
            <tbody>
              {detail.events.map((ev) => {
                const mc = detail.messageCounts.find(
                  (m) => m.eventNumber === ev.eventNumber
                );
                return (
                  <tr key={ev.eventNumber}>
                    <td>{ev.eventNumber}</td>
                    <td>{ev.age}</td>
                    <td>{ev.description}</td>
                    <td>{mc?.parent1 ?? 0}</td>
                    <td>{mc?.parent2 ?? 0}</td>
                    <td>{mc?.kid ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="detail-section">
        <h2>Sidebar Usage</h2>
        <p>
          Parent 1: {detail.sidebarUsed.parent1 ? "Used" : "Not used"} |{" "}
          Parent 2: {detail.sidebarUsed.parent2 ? "Used" : "Not used"}
        </p>
      </div>

      {detail.identitySnapshots.length > 0 && (
        <div className="detail-section">
          <h2>Identity Evolution</h2>
          {detail.identitySnapshots.map((snap) => (
            <details key={snap.eventNumber} style={{ marginBottom: "0.5rem" }}>
              <summary style={{ cursor: "pointer", color: "#aaa" }}>
                After Event {snap.eventNumber}
              </summary>
              <div className="identity-diff">{snap.document}</div>
            </details>
          ))}
        </div>
      )}

      <div className="detail-section">
        <h2>Current Identity Document</h2>
        <div className="identity-diff">{detail.identityDocument || "Not yet generated"}</div>
      </div>

      {detail.endgame && (
        <>
          <div className="detail-section">
            <h2>Epilogue</h2>
            <div className="identity-diff">{detail.endgame.epilogue}</div>
          </div>
          <div className="detail-section">
            <h2>Report Card</h2>
            <div className="identity-diff">{detail.endgame.reportCard}</div>
          </div>
        </>
      )}

      <div className="detail-section">
        <h2>LLM Cost</h2>
        <p style={{ color: "#666" }}>Cost tracking coming soon</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire GameDetailView into AdminApp**

In `client/src/components/admin/AdminApp.tsx`:

Add import:
```typescript
import { GameDetailView } from "./GameDetail";
```

Replace the game-detail placeholder (`{page === "game-detail" && selectedGameId && ...}`) with:

```tsx
      {page === "game-detail" && selectedGameId && (
        <GameDetailView
          gameId={selectedGameId}
          fetchGameDetail={api.fetchGameDetail}
          onBack={() => setPage("games")}
        />
      )}
```

- [ ] **Step 3: Verify the app builds**

Run: `cd client && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Start dev server and test the game detail page**

Navigate to `http://localhost:5173/admin`, authenticate, go to Games, click a game name.
Expected: See game detail view with status bar, events table, identity snapshots, sidebar usage. "Back to games" link returns to the list.

- [ ] **Step 5: Run all server tests to verify nothing is broken**

Run: `cd server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/admin/GameDetail.tsx client/src/components/admin/AdminApp.tsx
git commit -m "feat: add admin game detail page with events, identity, and endgame views"
```
