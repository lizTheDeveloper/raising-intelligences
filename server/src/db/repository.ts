import * as crypto from "node:crypto";
import type {
  ChildGender,
  GameEvent,
  GamePhase,
  GameState,
  Message,
  ParentPersonality,
  Sender,
} from "../types.js";
import { pool } from "./pool.js";
import type pg from "pg";

export interface IdentitySnapshot {
  eventNumber: number;
  document: string;
}

export interface PlayerRecord {
  slot: string;
  displayName: string;
  token: string;
}

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

/**
 * Write-through persistence for games. The in-memory `GameState` remains
 * authoritative during play; the repository mirrors each mutation to durable
 * storage so a session can be reconstructed from the latest checkpoint.
 */
export interface GameRepository {
  /** Upsert the top-level game checkpoint (phase, counters, identity doc). */
  saveGame(state: GameState): Promise<void>;
  saveMessage(gameId: string, message: Message): Promise<void>;
  saveEvent(gameId: string, event: GameEvent): Promise<void>;
  saveSnapshot(gameId: string, snapshot: IdentitySnapshot): Promise<void>;
  saveEndgame(
    gameId: string,
    epilogue: string,
    reportCard: string
  ): Promise<void>;
  /** Reconstruct an in-memory GameState from the latest checkpoint, or null. */
  loadGame(gameId: string): Promise<GameState | null>;
  savePlayer(gameId: string, slot: string, displayName: string, token: string): Promise<void>;
  loadPlayers(gameId: string): Promise<PlayerRecord[]>;

  // Album methods
  saveAlbumPartner(partner: { userId: string; partnerName: string; partnerType: string; relationshipSummary: string }): Promise<string>;
  saveAlbumMoments(gameId: string, moments: Array<{ age: number; title: string; description: string; momentType: string; imagePath: string | null; sortOrder: number }>): Promise<void>;
  linkGameToPartner(userId: string, gameId: string, partnerId: string): Promise<void>;
  loadAlbum(userId: string): Promise<{ partners: Array<AlbumPartner & { kids: Array<{ gameId: string; childName: string; createdAt: number }> }>; unlinkedKids: Array<{ gameId: string; childName: string; createdAt: number }> }>;
  loadScrapbook(userId: string, gameId: string): Promise<{ childName: string; partnerName: string | null; partnerType: string | null; relationshipSummary: string | null; moments: AlbumMoment[]; epilogue: string; reportCard: string } | null>;

  // Safety / moderation
  /** Persists a flagged parent message in full, for review — see safety/moderation.ts. */
  saveModerationFlag(record: {
    gameId: string;
    sender: Sender;
    content: string;
    reason: string;
    ipAddress: string | null;
  }): Promise<void>;
  banIp(ipAddress: string, reason: string): Promise<void>;
  isIpBanned(ipAddress: string): Promise<boolean>;
  /** Removes an IP from the ban list (admin unban). */
  unbanIp(ipAddress: string): Promise<void>;
  /**
   * Number of DISTINCT games this IP has ever been flagged in. Used to
   * escalate repeat offenders: a scene-level flag only ends the session on a
   * first offense, but a second flag in a *different* game permanently bans
   * the IP (see applyModerationBlock's "repeat-offender" policy).
   */
  countDistinctFlaggedGamesForIp(ipAddress: string): Promise<number>;
}

const DEFAULT_TOTAL_EVENTS = 10;

/**
 * Rebuild the derived, per-event in-memory fields (currentEvent,
 * parentMessageCount, sidebar flags) from the persisted phase and collections.
 * Persistence stores durable facts; ephemeral turn bookkeeping is recomputed.
 */
function reconstructState(input: {
  id: string;
  phase: GamePhase;
  childName: string;
  childGender?: ChildGender;
  relationshipType: string;
  personalitySeed?: string;
  parentPersonalities?: { parent1?: ParentPersonality; parent2?: ParentPersonality };
  currentEventNumber: number;
  totalEvents: number;
  identityDocument: string;
  memorySummary?: string;
  events: GameEvent[];
  messages: Message[];
  identitySnapshots: IdentitySnapshot[];
  sidebarUsed: { parent1: boolean; parent2: boolean };
  sidebarActive?: string | null;
}): GameState {
  const currentEvent =
    input.events.find((e) => e.eventNumber === input.currentEventNumber) ??
    null;

  const inChat =
    input.phase === "family_chat" ||
    input.phase === "sidebar" ||
    input.phase === "adult_chat";
  const parentMessageCount = inChat
    ? input.messages.filter(
        (m) =>
          m.sender !== "kid" &&
          m.chatType !== "debrief" &&
          m.eventNumber === input.currentEventNumber
      ).length
    : 0;

  return {
    id: input.id,
    phase: input.phase,
    childName: input.childName,
    childGender: input.childGender ?? "nonbinary",
    relationshipType: input.relationshipType,
    personalitySeed: input.personalitySeed ?? "",
    parentPersonalities: input.parentPersonalities ?? {},
    currentEvent,
    currentEventNumber: input.currentEventNumber,
    totalEvents: input.totalEvents,
    identityDocument: input.identityDocument,
    identitySnapshots: input.identitySnapshots,
    memorySummary: input.memorySummary ?? "",
    events: input.events,
    messages: input.messages,
    parentMessageCount,
    sidebarUsed: input.sidebarUsed,
    sidebarActive: (input.sidebarActive as GameState["sidebarActive"]) ?? null,
    concerningStreak: 0,
    pendingGuidance: null,
    lastActivityAt: Date.now(),
  };
}

export class PgGameRepository implements GameRepository {
  constructor(private db: Pick<pg.Pool, "query"> = pool) {}

  async saveGame(state: GameState): Promise<void> {
    await this.db.query(
      `INSERT INTO games
         (id, child_name, child_gender, relationship_type, phase, current_event_number,
          total_events, identity_document, memory_summary, personality_seed, parent_personalities,
          sidebar_used_parent1, sidebar_used_parent2, sidebar_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, now())
       ON CONFLICT (id) DO UPDATE SET
         child_name            = EXCLUDED.child_name,
         child_gender          = EXCLUDED.child_gender,
         relationship_type     = EXCLUDED.relationship_type,
         phase                 = EXCLUDED.phase,
         current_event_number  = EXCLUDED.current_event_number,
         total_events          = EXCLUDED.total_events,
         identity_document     = EXCLUDED.identity_document,
         memory_summary        = EXCLUDED.memory_summary,
         personality_seed      = EXCLUDED.personality_seed,
         parent_personalities  = EXCLUDED.parent_personalities,
         sidebar_used_parent1  = EXCLUDED.sidebar_used_parent1,
         sidebar_used_parent2  = EXCLUDED.sidebar_used_parent2,
         sidebar_active        = EXCLUDED.sidebar_active,
         updated_at            = now()`,
      [
        state.id,
        state.childName,
        state.childGender,
        state.relationshipType,
        state.phase,
        state.currentEventNumber,
        state.totalEvents,
        state.identityDocument,
        state.memorySummary,
        state.personalitySeed,
        JSON.stringify(state.parentPersonalities),
        state.sidebarUsed.parent1,
        state.sidebarUsed.parent2,
        state.sidebarActive ?? null,
      ]
    );
  }

  async saveMessage(gameId: string, message: Message): Promise<void> {
    await this.db.query(
      `INSERT INTO messages
         (game_id, sender, content, chat_type, visible_to, timestamp, event_number)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        gameId,
        message.sender,
        message.content,
        message.chatType,
        JSON.stringify(message.visibleTo),
        message.timestamp,
        message.eventNumber,
      ]
    );
  }

  async saveEvent(gameId: string, event: GameEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO events
         (game_id, event_number, age, description, setting, trigger)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (game_id, event_number) DO UPDATE SET
         age         = EXCLUDED.age,
         description = EXCLUDED.description,
         setting     = EXCLUDED.setting,
         trigger     = EXCLUDED.trigger`,
      [
        gameId,
        event.eventNumber,
        event.age,
        event.description,
        event.setting,
        event.trigger,
      ]
    );
  }

  async saveSnapshot(
    gameId: string,
    snapshot: IdentitySnapshot
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO identity_snapshots (game_id, event_number, document)
       VALUES ($1, $2, $3)
       ON CONFLICT (game_id, event_number) DO UPDATE SET
         document = EXCLUDED.document`,
      [gameId, snapshot.eventNumber, snapshot.document]
    );
  }

  async saveEndgame(
    gameId: string,
    epilogue: string,
    reportCard: string
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO endgames (game_id, epilogue, report_card)
       VALUES ($1, $2, $3)
       ON CONFLICT (game_id) DO UPDATE SET
         epilogue    = EXCLUDED.epilogue,
         report_card = EXCLUDED.report_card`,
      [gameId, epilogue, reportCard]
    );
  }

  async savePlayer(gameId: string, slot: string, displayName: string, token: string): Promise<void> {
    await this.db.query(
      `INSERT INTO players (game_id, slot, display_name, token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (game_id, slot) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         token        = EXCLUDED.token`,
      [gameId, slot, displayName, token]
    );
  }

  async loadPlayers(gameId: string): Promise<PlayerRecord[]> {
    const res = await this.db.query<{
      slot: string;
      display_name: string;
      token: string;
    }>(
      `SELECT slot, display_name, token FROM players WHERE game_id = $1`,
      [gameId]
    );
    return res.rows.map((r) => ({
      slot: r.slot,
      displayName: r.display_name,
      token: r.token,
    }));
  }

  async loadGame(gameId: string): Promise<GameState | null> {
    const gameRes = await this.db.query<{
      id: string;
      child_name: string;
      child_gender: ChildGender;
      relationship_type: string;
      phase: GamePhase;
      current_event_number: number;
      total_events: number;
      identity_document: string;
      memory_summary: string;
      personality_seed: string;
      parent_personalities: { parent1?: ParentPersonality; parent2?: ParentPersonality } | null;
      sidebar_used_parent1: boolean;
      sidebar_used_parent2: boolean;
      sidebar_active: string | null;
    }>(
      `SELECT id, child_name,
              COALESCE(child_gender, 'nonbinary') AS child_gender,
              relationship_type, phase,
              current_event_number, total_events, identity_document,
              COALESCE(memory_summary, '') AS memory_summary,
              COALESCE(personality_seed, '') AS personality_seed,
              parent_personalities,
              COALESCE(sidebar_used_parent1, false) AS sidebar_used_parent1,
              COALESCE(sidebar_used_parent2, false) AS sidebar_used_parent2,
              sidebar_active
       FROM games WHERE id = $1`,
      [gameId]
    );

    const game = gameRes.rows[0];
    if (!game) return null;

    const eventsRes = await this.db.query<{
      event_number: number;
      age: number;
      description: string;
      setting: string;
      trigger: string;
    }>(
      `SELECT event_number, age, description, setting, trigger
       FROM events WHERE game_id = $1 ORDER BY event_number ASC`,
      [gameId]
    );

    const messagesRes = await this.db.query<{
      sender: Sender;
      content: string;
      chat_type: Message["chatType"];
      visible_to: Sender[];
      timestamp: string;
      event_number: number;
    }>(
      `SELECT sender, content, chat_type, visible_to, timestamp,
              COALESCE(event_number, 0) AS event_number
       FROM messages WHERE game_id = $1 ORDER BY timestamp ASC, created_at ASC`,
      [gameId]
    );

    const snapshotsRes = await this.db.query<{
      event_number: number;
      document: string;
    }>(
      `SELECT event_number, document
       FROM identity_snapshots WHERE game_id = $1 ORDER BY event_number ASC`,
      [gameId]
    );

    const events: GameEvent[] = eventsRes.rows.map((r) => ({
      eventNumber: r.event_number,
      age: r.age,
      description: r.description,
      setting: r.setting,
      trigger: r.trigger,
    }));

    const messages: Message[] = messagesRes.rows.map((r) => ({
      sender: r.sender,
      content: r.content,
      chatType: r.chat_type,
      visibleTo: r.visible_to,
      timestamp: Number(r.timestamp),
      eventNumber: r.event_number,
    }));

    const identitySnapshots: IdentitySnapshot[] = snapshotsRes.rows.map(
      (r) => ({ eventNumber: r.event_number, document: r.document })
    );

    return reconstructState({
      id: game.id,
      phase: game.phase,
      childName: game.child_name,
      childGender: game.child_gender,
      relationshipType: game.relationship_type,
      personalitySeed: game.personality_seed,
      parentPersonalities: game.parent_personalities ?? {},
      currentEventNumber: game.current_event_number,
      totalEvents: game.total_events ?? DEFAULT_TOTAL_EVENTS,
      identityDocument: game.identity_document,
      memorySummary: game.memory_summary,
      events,
      messages,
      identitySnapshots,
      sidebarUsed: {
        parent1: game.sidebar_used_parent1,
        parent2: game.sidebar_used_parent2,
      },
      sidebarActive: game.sidebar_active,
    });
  }

  async saveAlbumPartner(partner: { userId: string; partnerName: string; partnerType: string; relationshipSummary: string }): Promise<string> {
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

  async saveAlbumMoments(gameId: string, moments: Array<{ age: number; title: string; description: string; momentType: string; imagePath: string | null; sortOrder: number }>): Promise<void> {
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

  async loadAlbum(userId: string): Promise<{ partners: Array<AlbumPartner & { kids: Array<{ gameId: string; childName: string; createdAt: number }> }>; unlinkedKids: Array<{ gameId: string; childName: string; createdAt: number }> }> {
    const partnersRes = await this.db.query<{
      id: string;
      user_id: string;
      partner_name: string;
      partner_type: string;
      relationship_summary: string;
    }>(
      `SELECT id, user_id, partner_name, partner_type, relationship_summary
       FROM album_partners WHERE user_id = $1`,
      [userId]
    );

    const partners: Array<AlbumPartner & { kids: Array<{ gameId: string; childName: string; createdAt: number }> }> = [];
    for (const p of partnersRes.rows) {
      const kidsRes = await this.db.query<{ game_id: string; child_name: string; created_at: string }>(
        `SELECT game_id, child_name, created_at FROM user_games
         WHERE user_id = $1 AND partner_id = $2 ORDER BY created_at DESC`,
        [userId, p.id]
      );
      partners.push({
        id: p.id,
        userId: p.user_id,
        partnerName: p.partner_name,
        partnerType: p.partner_type as "real" | "generated",
        relationshipSummary: p.relationship_summary,
        kids: kidsRes.rows.map((k) => ({
          gameId: k.game_id,
          childName: k.child_name,
          createdAt: new Date(k.created_at).getTime(),
        })),
      });
    }

    const unlinkedRes = await this.db.query<{ game_id: string; child_name: string; created_at: string }>(
      `SELECT game_id, child_name, created_at FROM user_games
       WHERE user_id = $1 AND partner_id IS NULL ORDER BY created_at DESC`,
      [userId]
    );
    const unlinkedKids = unlinkedRes.rows.map((r) => ({
      gameId: r.game_id,
      childName: r.child_name,
      createdAt: new Date(r.created_at).getTime(),
    }));

    return { partners, unlinkedKids };
  }

  async loadScrapbook(userId: string, gameId: string): Promise<{ childName: string; partnerName: string | null; partnerType: string | null; relationshipSummary: string | null; moments: AlbumMoment[]; epilogue: string; reportCard: string } | null> {
    const ugRes = await this.db.query<{
      child_name: string;
      partner_name: string | null;
      partner_type: string | null;
      relationship_summary: string | null;
      epilogue: string | null;
      report_card: string | null;
    }>(
      `SELECT ug.child_name,
              ap.partner_name,
              ap.partner_type,
              ap.relationship_summary,
              eg.epilogue,
              eg.report_card
       FROM user_games ug
       LEFT JOIN album_partners ap ON ap.id = ug.partner_id
       LEFT JOIN endgames eg ON eg.game_id = ug.game_id
       WHERE ug.user_id = $1 AND ug.game_id = $2`,
      [userId, gameId]
    );

    if (ugRes.rows.length === 0) return null;
    const row = ugRes.rows[0];

    const momentsRes = await this.db.query<{
      id: string;
      game_id: string;
      age: number;
      title: string;
      description: string;
      moment_type: string;
      image_path: string | null;
      sort_order: number;
    }>(
      `SELECT id, game_id, age, title, description, moment_type, image_path, sort_order
       FROM album_moments WHERE game_id = $1 ORDER BY sort_order ASC`,
      [gameId]
    );

    return {
      childName: row.child_name,
      partnerName: row.partner_name,
      partnerType: row.partner_type,
      relationshipSummary: row.relationship_summary,
      epilogue: row.epilogue ?? "",
      reportCard: row.report_card ?? "",
      moments: momentsRes.rows.map((m) => ({
        id: m.id,
        gameId: m.game_id,
        age: m.age,
        title: m.title,
        description: m.description,
        momentType: m.moment_type,
        imagePath: m.image_path,
        sortOrder: m.sort_order,
      })),
    };
  }

  async saveModerationFlag(record: {
    gameId: string;
    sender: Sender;
    content: string;
    reason: string;
    ipAddress: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO moderation_flags (game_id, sender, content, reason, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [record.gameId, record.sender, record.content, record.reason, record.ipAddress]
    );
  }

  async banIp(ipAddress: string, reason: string): Promise<void> {
    await this.db.query(
      `INSERT INTO banned_ips (ip_address, reason) VALUES ($1, $2)
       ON CONFLICT (ip_address) DO NOTHING`,
      [ipAddress, reason]
    );
  }

  async isIpBanned(ipAddress: string): Promise<boolean> {
    const res = await this.db.query("SELECT 1 FROM banned_ips WHERE ip_address = $1", [ipAddress]);
    return res.rows.length > 0;
  }

  async unbanIp(ipAddress: string): Promise<void> {
    await this.db.query("DELETE FROM banned_ips WHERE ip_address = $1", [ipAddress]);
  }

  async countDistinctFlaggedGamesForIp(ipAddress: string): Promise<number> {
    const res = await this.db.query<{ n: string }>(
      "SELECT COUNT(DISTINCT game_id)::text AS n FROM moderation_flags WHERE ip_address = $1",
      [ipAddress]
    );
    return parseInt(res.rows[0]?.n ?? "0", 10);
  }
}

/**
 * In-memory implementation of GameRepository for tests and for running the
 * game without a Postgres connection.
 */
export class InMemoryGameRepository implements GameRepository {
  private games = new Map<
    string,
    {
      id: string;
      childName: string;
      childGender: ChildGender;
      relationshipType: string;
      personalitySeed: string;
      parentPersonalities: { parent1?: ParentPersonality; parent2?: ParentPersonality };
      phase: GamePhase;
      currentEventNumber: number;
      totalEvents: number;
      identityDocument: string;
      memorySummary: string;
      sidebarUsedParent1: boolean;
      sidebarUsedParent2: boolean;
      sidebarActive: string | null;
    }
  >();
  private messages = new Map<string, Message[]>();
  private events = new Map<string, Map<number, GameEvent>>();
  private snapshots = new Map<string, Map<number, IdentitySnapshot>>();
  private endgames = new Map<string, { epilogue: string; reportCard: string }>();
  private playerRecords = new Map<string, Map<string, PlayerRecord>>();
  private albumPartners = new Map<string, { id: string; userId: string; partnerName: string; partnerType: string; relationshipSummary: string }>();
  private albumMoments = new Map<string, Array<AlbumMoment>>();
  private userGames = new Map<string, { userId: string; gameId: string; childName: string; partnerId: string | null; createdAt: number }>();
  private partnerLinks = new Map<string, string>();
  private moderationFlags: Array<{ gameId: string; sender: Sender; content: string; reason: string; ipAddress: string | null }> = [];
  private bannedIps = new Set<string>();

  async saveGame(state: GameState): Promise<void> {
    this.games.set(state.id, {
      id: state.id,
      childName: state.childName,
      childGender: state.childGender,
      relationshipType: state.relationshipType,
      personalitySeed: state.personalitySeed,
      parentPersonalities: state.parentPersonalities,
      phase: state.phase,
      currentEventNumber: state.currentEventNumber,
      totalEvents: state.totalEvents,
      identityDocument: state.identityDocument,
      memorySummary: state.memorySummary,
      sidebarUsedParent1: state.sidebarUsed.parent1,
      sidebarUsedParent2: state.sidebarUsed.parent2,
      sidebarActive: state.sidebarActive ?? null,
    });
  }

  async saveMessage(gameId: string, message: Message): Promise<void> {
    const list = this.messages.get(gameId) ?? [];
    list.push({ ...message, visibleTo: [...message.visibleTo] });
    this.messages.set(gameId, list);
  }

  async saveEvent(gameId: string, event: GameEvent): Promise<void> {
    const map = this.events.get(gameId) ?? new Map<number, GameEvent>();
    map.set(event.eventNumber, { ...event });
    this.events.set(gameId, map);
  }

  async saveSnapshot(
    gameId: string,
    snapshot: IdentitySnapshot
  ): Promise<void> {
    const map =
      this.snapshots.get(gameId) ?? new Map<number, IdentitySnapshot>();
    map.set(snapshot.eventNumber, { ...snapshot });
    this.snapshots.set(gameId, map);
  }

  async saveEndgame(
    gameId: string,
    epilogue: string,
    reportCard: string
  ): Promise<void> {
    this.endgames.set(gameId, { epilogue, reportCard });
  }

  async savePlayer(gameId: string, slot: string, displayName: string, token: string): Promise<void> {
    const map = this.playerRecords.get(gameId) ?? new Map<string, PlayerRecord>();
    map.set(slot, { slot, displayName, token });
    this.playerRecords.set(gameId, map);
  }

  async loadPlayers(gameId: string): Promise<PlayerRecord[]> {
    return [...(this.playerRecords.get(gameId)?.values() ?? [])];
  }

  async loadGame(gameId: string): Promise<GameState | null> {
    const game = this.games.get(gameId);
    if (!game) return null;

    const events = [...(this.events.get(gameId)?.values() ?? [])].sort(
      (a, b) => a.eventNumber - b.eventNumber
    );
    const messages = [...(this.messages.get(gameId) ?? [])].sort(
      (a, b) => a.timestamp - b.timestamp
    );
    const identitySnapshots = [
      ...(this.snapshots.get(gameId)?.values() ?? []),
    ].sort((a, b) => a.eventNumber - b.eventNumber);

    return reconstructState({
      id: game.id,
      phase: game.phase,
      childName: game.childName,
      childGender: game.childGender,
      relationshipType: game.relationshipType,
      personalitySeed: game.personalitySeed,
      parentPersonalities: game.parentPersonalities,
      currentEventNumber: game.currentEventNumber,
      totalEvents: game.totalEvents,
      identityDocument: game.identityDocument,
      memorySummary: game.memorySummary,
      events: events.map((e) => ({ ...e })),
      messages: messages.map((m) => ({ ...m, visibleTo: [...m.visibleTo] })),
      identitySnapshots: identitySnapshots.map((s) => ({ ...s })),
      sidebarUsed: {
        parent1: game.sidebarUsedParent1,
        parent2: game.sidebarUsedParent2,
      },
      sidebarActive: game.sidebarActive,
    });
  }

  /** Test helper: read the persisted endgame, if any. */
  async getEndgame(
    gameId: string
  ): Promise<{ epilogue: string; reportCard: string } | null> {
    return this.endgames.get(gameId) ?? null;
  }

  /** Test helper: simulate INSERT INTO user_games. */
  async addUserGame(userId: string, gameId: string, childName: string, partnerId?: string): Promise<void> {
    const key = `${userId}:${gameId}`;
    if (!this.userGames.has(key)) {
      this.userGames.set(key, { userId, gameId, childName, partnerId: partnerId ?? null, createdAt: Date.now() });
    }
  }

  /** Test helper: directly insert an album partner. */
  addAlbumPartner(userId: string, partner: { id: string; partnerName: string; partnerType: string; relationshipSummary: string; kids: unknown[] }): void {
    this.albumPartners.set(partner.id, {
      id: partner.id,
      userId,
      partnerName: partner.partnerName,
      partnerType: partner.partnerType,
      relationshipSummary: partner.relationshipSummary,
    });
  }

  async saveAlbumPartner(partner: { userId: string; partnerName: string; partnerType: string; relationshipSummary: string }): Promise<string> {
    // Check for existing partner with same (userId, partnerName, partnerType)
    for (const [, p] of this.albumPartners) {
      if (p.userId === partner.userId && p.partnerName === partner.partnerName && p.partnerType === partner.partnerType) {
        p.relationshipSummary = partner.relationshipSummary;
        return p.id;
      }
    }
    const id = crypto.randomUUID();
    this.albumPartners.set(id, {
      id,
      userId: partner.userId,
      partnerName: partner.partnerName,
      partnerType: partner.partnerType,
      relationshipSummary: partner.relationshipSummary,
    });
    return id;
  }

  async saveAlbumMoments(gameId: string, moments: Array<{ age: number; title: string; description: string; momentType: string; imagePath: string | null; sortOrder: number }>): Promise<void> {
    const existing = this.albumMoments.get(gameId) ?? [];
    for (const m of moments) {
      existing.push({
        id: crypto.randomUUID(),
        gameId,
        age: m.age,
        title: m.title,
        description: m.description,
        momentType: m.momentType,
        imagePath: m.imagePath,
        sortOrder: m.sortOrder,
      });
    }
    this.albumMoments.set(gameId, existing);
  }

  async linkGameToPartner(userId: string, gameId: string, partnerId: string): Promise<void> {
    const key = `${userId}:${gameId}`;
    const ug = this.userGames.get(key);
    if (ug) {
      ug.partnerId = partnerId;
    }
    this.partnerLinks.set(key, partnerId);
  }

  async loadAlbum(userId: string): Promise<{ partners: Array<AlbumPartner & { kids: Array<{ gameId: string; childName: string; createdAt: number }> }>; unlinkedKids: Array<{ gameId: string; childName: string; createdAt: number }> }> {
    // Gather all partners for this user
    const userPartners = [...this.albumPartners.values()].filter((p) => p.userId === userId);

    const partners: Array<AlbumPartner & { kids: Array<{ gameId: string; childName: string; createdAt: number }> }> = [];
    for (const p of userPartners) {
      const kids: Array<{ gameId: string; childName: string; createdAt: number }> = [];
      for (const [, ug] of this.userGames) {
        if (ug.userId === userId && ug.partnerId === p.id) {
          kids.push({ gameId: ug.gameId, childName: ug.childName, createdAt: ug.createdAt });
        }
      }
      kids.sort((a, b) => b.createdAt - a.createdAt);
      partners.push({
        id: p.id,
        userId: p.userId,
        partnerName: p.partnerName,
        partnerType: p.partnerType as "real" | "generated",
        relationshipSummary: p.relationshipSummary,
        kids,
      });
    }

    const unlinkedKids: Array<{ gameId: string; childName: string; createdAt: number }> = [];
    for (const [, ug] of this.userGames) {
      if (ug.userId === userId && ug.partnerId === null) {
        unlinkedKids.push({ gameId: ug.gameId, childName: ug.childName, createdAt: ug.createdAt });
      }
    }
    unlinkedKids.sort((a, b) => b.createdAt - a.createdAt);

    return { partners, unlinkedKids };
  }

  async loadScrapbook(userId: string, gameId: string): Promise<{ childName: string; partnerName: string | null; partnerType: string | null; relationshipSummary: string | null; moments: AlbumMoment[]; epilogue: string; reportCard: string } | null> {
    const key = `${userId}:${gameId}`;
    const ug = this.userGames.get(key);
    if (!ug) return null;

    let partnerName: string | null = null;
    let partnerType: string | null = null;
    let relationshipSummary: string | null = null;
    if (ug.partnerId) {
      const partner = this.albumPartners.get(ug.partnerId);
      if (partner) {
        partnerName = partner.partnerName;
        partnerType = partner.partnerType;
        relationshipSummary = partner.relationshipSummary;
      }
    }

    const endgame = this.endgames.get(gameId);
    const moments = (this.albumMoments.get(gameId) ?? [])
      .map((m) => ({ ...m }))
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return {
      childName: ug.childName,
      partnerName,
      partnerType,
      relationshipSummary,
      moments,
      epilogue: endgame?.epilogue ?? "",
      reportCard: endgame?.reportCard ?? "",
    };
  }

  async saveModerationFlag(record: {
    gameId: string;
    sender: Sender;
    content: string;
    reason: string;
    ipAddress: string | null;
  }): Promise<void> {
    this.moderationFlags.push({ ...record });
  }

  async banIp(ipAddress: string, _reason: string): Promise<void> {
    this.bannedIps.add(ipAddress);
  }

  async isIpBanned(ipAddress: string): Promise<boolean> {
    return this.bannedIps.has(ipAddress);
  }

  async unbanIp(ipAddress: string): Promise<void> {
    this.bannedIps.delete(ipAddress);
  }

  async countDistinctFlaggedGamesForIp(ipAddress: string): Promise<number> {
    const gameIds = new Set(
      this.moderationFlags.filter((f) => f.ipAddress === ipAddress).map((f) => f.gameId)
    );
    return gameIds.size;
  }

  /** Test-only accessor — inspect persisted flags without a DB. */
  getModerationFlags(): Array<{ gameId: string; sender: Sender; content: string; reason: string; ipAddress: string | null }> {
    return [...this.moderationFlags];
  }
}
