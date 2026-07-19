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

export interface MessageDetail {
  eventNumber: number;
  sender: string;
  content: string;
  chatType: string;
  timestamp: number;
}

export interface GameDetail extends GameSummary {
  relationshipType: string;
  identityDocument: string;
  events: EventDetail[];
  messageCounts: MessageCounts[];
  messages: MessageDetail[];
  identitySnapshots: { eventNumber: number; document: string }[];
  sidebarUsed: { parent1: boolean; parent2: boolean };
  endgame: { epilogue: string; reportCard: string } | null;
}

export interface ModerationFlagSummary {
  id: string;
  gameId: string;
  childName: string | null;
  sender: string;
  reason: string;
  content: string;
  ipAddress: string | null;
  createdAt: string;
}

export interface ListModerationFlagsOptions {
  limit?: number;
  offset?: number;
}

export interface AdminQueries {
  getOverview(abandonedThresholdDays?: number): Promise<OverviewStats>;
  listGames(opts?: ListGamesOptions): Promise<{ games: GameSummary[]; total: number }>;
  getGameDetail(gameId: string): Promise<GameDetail | null>;
  listModerationFlags(
    opts?: ListModerationFlagsOptions
  ): Promise<{ flags: ModerationFlagSummary[]; total: number }>;
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
  content: string;
  chatType: string;
  timestamp: number;
}

export class InMemoryAdminQueries implements AdminQueries {
  private games = new Map<string, StoredGame>();
  private players = new Map<string, StoredPlayer[]>();
  private events = new Map<string, StoredEvent[]>();
  private messages = new Map<string, StoredMessage[]>();
  private snapshots = new Map<string, { eventNumber: number; document: string }[]>();
  private endgames = new Map<string, { epilogue: string; reportCard: string }>();
  private moderationFlags: Array<{
    id: string;
    gameId: string;
    sender: string;
    reason: string;
    content: string;
    ipAddress: string | null;
    createdAt: Date;
  }> = [];

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

  addModerationFlag(flag: {
    id?: string;
    gameId: string;
    sender: string;
    reason: string;
    content?: string;
    ipAddress: string | null;
    createdAt?: Date;
  }): void {
    this.moderationFlags.push({
      id: flag.id ?? `mf-${this.moderationFlags.length + 1}`,
      gameId: flag.gameId,
      sender: flag.sender,
      reason: flag.reason,
      content: flag.content ?? "",
      ipAddress: flag.ipAddress,
      createdAt: flag.createdAt ?? new Date(),
    });
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

    const messages: MessageDetail[] = msgs
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((m) => ({
        eventNumber: m.eventNumber,
        sender: m.sender,
        content: m.content,
        chatType: m.chatType,
        timestamp: m.timestamp,
      }));

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
      messages,
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

  async listModerationFlags(
    opts: ListModerationFlagsOptions = {}
  ): Promise<{ flags: ModerationFlagSummary[]; total: number }> {
    const { limit = 100, offset = 0 } = opts;
    const sorted = [...this.moderationFlags].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
    const total = sorted.length;
    const page = sorted.slice(offset, offset + limit);
    return {
      total,
      flags: page.map((f) => ({
        id: f.id,
        gameId: f.gameId,
        childName: this.games.get(f.gameId)?.childName ?? null,
        sender: f.sender,
        reason: f.reason,
        content: f.content,
        ipAddress: f.ipAddress,
        createdAt: f.createdAt.toISOString(),
      })),
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
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const gameIds = gamesRes.rows.map((r) => r.id);
    const playersByGame = new Map<string, { slot: string; displayName: string | null }[]>();
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

    const [playersRes, eventsRes, msgsRes, fullMsgsRes, snapshotsRes, endgameRes] = await Promise.all([
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
      query<{
        event_number: number; sender: string; content: string;
        chat_type: string; timestamp: string;
      }>(
        `SELECT COALESCE(event_number, 0) AS event_number, sender, content,
                COALESCE(chat_type, 'shared') AS chat_type, COALESCE(timestamp, 0)::text AS timestamp
         FROM messages WHERE game_id = $1 ORDER BY timestamp ASC`,
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
      messages: fullMsgsRes.rows.map((m) => ({
        eventNumber: m.event_number,
        sender: m.sender,
        content: m.content,
        chatType: m.chat_type,
        timestamp: parseInt(m.timestamp, 10),
      })),
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

  async listModerationFlags(
    opts: ListModerationFlagsOptions = {}
  ): Promise<{ flags: ModerationFlagSummary[]; total: number }> {
    const { limit = 100, offset = 0 } = opts;

    const countRes = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM moderation_flags"
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const res = await query<{
      id: string;
      game_id: string;
      child_name: string | null;
      sender: string;
      reason: string;
      content: string;
      ip_address: string | null;
      created_at: Date;
    }>(
      `SELECT mf.id, mf.game_id, g.child_name, mf.sender, mf.reason, mf.content,
              mf.ip_address, mf.created_at
       FROM moderation_flags mf
       LEFT JOIN games g ON g.id = mf.game_id
       ORDER BY mf.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      total,
      flags: res.rows.map((r) => ({
        id: r.id,
        gameId: r.game_id,
        childName: r.child_name,
        sender: r.sender,
        reason: r.reason,
        content: r.content,
        ipAddress: r.ip_address,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }
}
