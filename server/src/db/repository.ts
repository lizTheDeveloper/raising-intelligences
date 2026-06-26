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

export interface AlbumKid {
  gameId: string;
  childName: string;
  createdAt: number;
  hasAlbumData: boolean;
}

export interface AlbumPartner {
  id: string;
  partnerName: string;
  partnerType: string;
  relationshipSummary: string;
  kids: AlbumKid[];
}

export interface Album {
  partners: AlbumPartner[];
  unlinkedKids: AlbumKid[];
}

export interface AlbumMoment {
  age: number;
  title: string;
  description: string;
  momentType: string;
  imageUrl: string | null;
}

export interface Scrapbook {
  childName: string;
  partnerName: string | null;
  partnerType: string | null;
  relationshipSummary: string;
  moments: AlbumMoment[];
  epilogue: string;
  reportCard: string;
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

  /** Return the album overview for a user: partners with their kids, plus unlinked kids. */
  loadAlbum(userId: string): Promise<Album>;
  /** Return the full scrapbook for a single kid, or null if the game doesn't exist for this user. */
  loadScrapbook(userId: string, gameId: string): Promise<Scrapbook | null>;
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
    events: input.events,
    messages: input.messages,
    parentMessageCount,
    sidebarUsed: input.sidebarUsed,
    sidebarActive: (input.sidebarActive as GameState["sidebarActive"]) ?? null,
    lastActivityAt: Date.now(),
  };
}

export class PgGameRepository implements GameRepository {
  constructor(private db: Pick<pg.Pool, "query"> = pool) {}

  async saveGame(state: GameState): Promise<void> {
    await this.db.query(
      `INSERT INTO games
         (id, child_name, child_gender, relationship_type, phase, current_event_number,
          total_events, identity_document, personality_seed, parent_personalities,
          sidebar_used_parent1, sidebar_used_parent2, sidebar_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, now())
       ON CONFLICT (id) DO UPDATE SET
         child_name            = EXCLUDED.child_name,
         child_gender          = EXCLUDED.child_gender,
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
        state.childGender,
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

  async loadAlbum(userId: string): Promise<Album> {
    // Fetch all kids for this user, with optional partner link
    const kidsRes = await this.db.query<{
      game_id: string;
      child_name: string;
      created_at: string;
      partner_id: string | null;
    }>(
      `SELECT game_id, child_name, created_at, partner_id
       FROM user_games WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );

    // Fetch all partners for this user
    const partnersRes = await this.db.query<{
      id: string;
      partner_name: string;
      partner_type: string;
      relationship_summary: string;
    }>(
      `SELECT id, partner_name, partner_type, relationship_summary
       FROM album_partners WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );

    // Check which games have album moments
    const gameIds = kidsRes.rows.map(r => r.game_id);
    let albumDataSet = new Set<string>();
    if (gameIds.length > 0) {
      const momentsRes = await this.db.query<{ game_id: string }>(
        `SELECT DISTINCT game_id FROM album_moments WHERE game_id = ANY($1::uuid[])`,
        [gameIds]
      );
      albumDataSet = new Set(momentsRes.rows.map(r => r.game_id));
    }

    // Build partner map
    const partnerMap = new Map<string, AlbumPartner>();
    for (const p of partnersRes.rows) {
      partnerMap.set(p.id, {
        id: p.id,
        partnerName: p.partner_name,
        partnerType: p.partner_type,
        relationshipSummary: p.relationship_summary,
        kids: [],
      });
    }

    const unlinkedKids: AlbumKid[] = [];
    for (const r of kidsRes.rows) {
      const kid: AlbumKid = {
        gameId: r.game_id,
        childName: r.child_name,
        createdAt: new Date(r.created_at).getTime(),
        hasAlbumData: albumDataSet.has(r.game_id),
      };
      if (r.partner_id && partnerMap.has(r.partner_id)) {
        partnerMap.get(r.partner_id)!.kids.push(kid);
      } else {
        unlinkedKids.push(kid);
      }
    }

    return {
      partners: [...partnerMap.values()],
      unlinkedKids,
    };
  }

  async loadScrapbook(userId: string, gameId: string): Promise<Scrapbook | null> {
    // Verify the game belongs to this user
    const ugRes = await this.db.query<{
      game_id: string;
      child_name: string;
      partner_id: string | null;
    }>(
      `SELECT game_id, child_name, partner_id
       FROM user_games WHERE user_id = $1 AND game_id = $2`,
      [userId, gameId]
    );
    const ug = ugRes.rows[0];
    if (!ug) return null;

    // Load partner info if linked
    let partnerName: string | null = null;
    let partnerType: string | null = null;
    let relationshipSummary = "";
    if (ug.partner_id) {
      const pRes = await this.db.query<{
        partner_name: string;
        partner_type: string;
        relationship_summary: string;
      }>(
        `SELECT partner_name, partner_type, relationship_summary
         FROM album_partners WHERE id = $1`,
        [ug.partner_id]
      );
      if (pRes.rows[0]) {
        partnerName = pRes.rows[0].partner_name;
        partnerType = pRes.rows[0].partner_type;
        relationshipSummary = pRes.rows[0].relationship_summary;
      }
    }

    // Load moments
    const momentsRes = await this.db.query<{
      age: number;
      title: string;
      description: string;
      moment_type: string;
      image_path: string | null;
    }>(
      `SELECT age, title, description, moment_type, image_path
       FROM album_moments WHERE game_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [gameId]
    );

    // Load endgame data
    const endRes = await this.db.query<{ epilogue: string; report_card: string }>(
      `SELECT epilogue, report_card FROM endgames WHERE game_id = $1`,
      [gameId]
    );

    return {
      childName: ug.child_name,
      partnerName,
      partnerType,
      relationshipSummary,
      moments: momentsRes.rows.map(r => ({
        age: r.age,
        title: r.title,
        description: r.description,
        momentType: r.moment_type,
        imageUrl: r.image_path,
      })),
      epilogue: endRes.rows[0]?.epilogue ?? "",
      reportCard: endRes.rows[0]?.report_card ?? "",
    };
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

  /** In-memory album data stores, populated via test helpers. */
  private userGames = new Map<string, Array<{ gameId: string; childName: string; createdAt: number; partnerId: string | null }>>();
  private albumPartners = new Map<string, AlbumPartner>();
  private albumMoments = new Map<string, AlbumMoment[]>();
  /** Maps partnerId -> userId for reverse lookups. */
  private partnerOwners = new Map<string, string>();

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

  async loadAlbum(userId: string): Promise<Album> {
    const kids = this.userGames.get(userId) ?? [];

    // Build partner map
    const partnerMap = new Map<string, AlbumPartner>();
    for (const [id, partner] of this.albumPartners) {
      if (this.partnerOwners.get(id) === userId) {
        partnerMap.set(id, { ...partner, kids: [] });
      }
    }

    const unlinkedKids: AlbumKid[] = [];
    for (const ug of kids) {
      const hasAlbumData = (this.albumMoments.get(ug.gameId) ?? []).length > 0;
      const kid: AlbumKid = {
        gameId: ug.gameId,
        childName: ug.childName,
        createdAt: ug.createdAt,
        hasAlbumData,
      };
      if (ug.partnerId && partnerMap.has(ug.partnerId)) {
        partnerMap.get(ug.partnerId)!.kids.push(kid);
      } else {
        unlinkedKids.push(kid);
      }
    }

    return {
      partners: [...partnerMap.values()],
      unlinkedKids,
    };
  }

  async loadScrapbook(userId: string, gameId: string): Promise<Scrapbook | null> {
    const kids = this.userGames.get(userId) ?? [];
    const ug = kids.find(k => k.gameId === gameId);
    if (!ug) return null;

    let partnerName: string | null = null;
    let partnerType: string | null = null;
    let relationshipSummary = "";
    if (ug.partnerId) {
      const partner = this.albumPartners.get(ug.partnerId);
      if (partner) {
        partnerName = partner.partnerName;
        partnerType = partner.partnerType;
        relationshipSummary = partner.relationshipSummary;
      }
    }

    const endgame = this.endgames.get(gameId);
    const moments = this.albumMoments.get(gameId) ?? [];

    return {
      childName: ug.childName,
      partnerName,
      partnerType,
      relationshipSummary,
      moments: [...moments],
      epilogue: endgame?.epilogue ?? "",
      reportCard: endgame?.reportCard ?? "",
    };
  }

  /** Test helper: link a game to a user (simulates user_games table). */
  addUserGame(userId: string, gameId: string, childName: string, partnerId: string | null = null): void {
    const list = this.userGames.get(userId) ?? [];
    list.push({ gameId, childName, createdAt: Date.now(), partnerId });
    this.userGames.set(userId, list);
  }

  /** Test helper: create an album partner. */
  addAlbumPartner(userId: string, partner: AlbumPartner): void {
    this.albumPartners.set(partner.id, partner);
    this.partnerOwners.set(partner.id, userId);
  }

  /** Test helper: add album moments for a game. */
  addAlbumMoments(gameId: string, moments: AlbumMoment[]): void {
    this.albumMoments.set(gameId, moments);
  }
}
