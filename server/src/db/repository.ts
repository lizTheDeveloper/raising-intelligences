import * as crypto from "node:crypto";
import type {
  ChildGender,
  GameEvent,
  GamePhase,
  GameState,
  Message,
  ParentPersonality,
  Sender,
  TherapyMessage,
} from "../types.js";
import { pool } from "./pool.js";
import type pg from "pg";
import { ESCALATION_DARK_CONCERN } from "../safety/escalation.js";

export interface IdentitySnapshot {
  eventNumber: number;
  document: string;
}

export interface PlayerRecord {
  slot: string;
  displayName: string;
  token: string;
  /** Matrix user id, when the player was signed in; null/undefined otherwise. */
  userId?: string;
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
  savePlayer(gameId: string, slot: string, displayName: string, token: string, userId?: string): Promise<void>;
  loadPlayers(gameId: string): Promise<PlayerRecord[]>;
  /** Associate a signed-in user with a game (the album's kid row). Idempotent —
   * ON CONFLICT DO NOTHING so an existing row is left untouched. */
  saveUserGame(userId: string, gameId: string, childName: string): Promise<void>;

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

  /** Tier A "concern" events — dark-but-in-fiction parenting; never bans. See safety/moderation.ts. */
  saveConcernEvent(event: { gameId: string; sender: Sender; reason: string; ipAddress: string | null }): Promise<void>;
  loadConcernEvents(gameId: string): Promise<Array<{ sender: string; reason: string; createdAt: number }>>;

  // Dark Play Plan 4 — escalation detection (flag-for-review only, never bans).
  /**
   * Records the creating IP on a game — the denominator prerequisite for the
   * escalation ratio (see safety/escalation.ts). Not surfaced on GameState;
   * written directly to the `games.ip_address` column.
   */
  recordGameIp(gameId: string, ipAddress: string | null): Promise<void>;
  /**
   * The IP's cross-game play profile: how many games total, how many were
   * dark, how many showed ordinary range. THE safety-critical query — see
   * safety/escalation.ts `isEscalation` for why `ordinaryGames` must never
   * be dropped from the resulting predicate.
   */
  getIpPlayProfile(ipAddress: string): Promise<{ totalGames: number; darkGames: number; ordinaryGames: number }>;
  /** Persists a reviewable escalation flag. Never a ban — see safety/escalation.ts. */
  saveEscalationFlag(record: {
    ipAddress: string;
    gameId: string;
    totalGames: number;
    darkGames: number;
    ordinaryGames: number;
  }): Promise<void>;
  /** Whether this IP already has an escalation flag on file — evaluateEscalation records once per IP. */
  hasEscalationFlagForIp(ipAddress: string): Promise<boolean>;

  /**
   * Data-subject erasure (issue #141): deletes every game this user is
   * linked to via `user_games` — cascading to that game's players, events,
   * messages, identity snapshots, endgame, moderation flags, and album
   * moments — plus this user's album partners and concern/escalation rows
   * (the two tables not wired to `games` via `ON DELETE CASCADE`).
   *
   * Scoped to what the user themselves can request self-service: it removes
   * everything keyed to their `userId`, not a full retention/purge policy
   * (IP logs on games other users co-own, etc. — see issue #141's other
   * open items).
   *
   * Returns the ids of the games that were deleted.
   */
  deleteUserData(userId: string): Promise<{ deletedGameIds: string[] }>;
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
  concernLevel?: number;
  highestRungFired?: number;
  cpsOutcome?: "stay" | "safety_plan" | "removal" | null;
  therapyMessages?: TherapyMessage[];
  interventionText?: string | null;
}): GameState {
  /**
   * `event_intro` means "between scenes" — there is no current scene, ever.
   *
   * The games row cannot represent "no current event": it stores only
   * `current_event_number`, and both reducers that land on `event_intro`
   * (END_DEBRIEF, END_INTERVENTION) null `currentEvent` WITHOUT advancing that
   * number. So a game parked between scenes persists as
   * "phase=event_intro, current_event_number=N" while the events table still
   * holds scene N — and re-deriving the event by number resurrected the scene
   * the pair had just finished. Deterministic, not a race: every reload did it,
   * and a handoff IS a reload.
   *
   * Nulling it unconditionally at `event_intro` is lossless, because no live
   * transition ever persists a *pending* scene in this phase:
   *   - START_EVENT (the REST `/next-event` path, and applyPrefetchedEvent)
   *     lands directly in `family_chat`, so it never saves `event_intro`;
   *   - LOAD_EVENT does leave `event_intro` + an event, but the socket READY
   *     handler follows it with beginChat() inside the same lock and only then
   *     saves — so what reaches the database is `family_chat`.
   * The only producers of persisted "event_intro + a live event" are the
   * between-scenes artifact above and games stranded by the retired two-round
   * ready gate; both want a fresh scene at the next gate, which is exactly what
   * a null yields (LOAD_EVENT is guarded on `currentEvent === null`).
   *
   * The `normalizeRehydrated` / `sceneAlreadyPlayed` guard in
   * socket/handlers.ts stays as defence in depth — it now has nothing to
   * repair on this path, which is the point.
   */
  const currentEvent =
    input.phase === "event_intro"
      ? null
      : input.events.find((e) => e.eventNumber === input.currentEventNumber) ??
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
    concernLevel: input.concernLevel ?? 0,
    highestRungFired: input.highestRungFired ?? 0,
    // Persisted (migration 019), exactly like therapyMessages and cpsOutcome
    // beside it. This used to be a hardcoded null, which meant the consult and
    // cps_review screens survived only as long as the process that generated
    // them: any rehydration — restart, eviction, a second server — blanked both
    // to their "..." fallback while therapy (whose text lives in
    // therapyMessages) came back intact. Null remains the correct value outside
    // those two phases; END_INTERVENTION and the rung-2 branch both clear it, so
    // nothing stale can carry forward.
    interventionText: input.interventionText ?? null,
    therapyMessages: input.therapyMessages ?? [],
    cpsOutcome: input.cpsOutcome ?? null,
    // Not persisted anywhere the games row can reach: the endgames row that
    // holds the epilogue is only written at report-card time. A game
    // rehydrated in the `epilogue` phase therefore comes back without its
    // text, and the socket REPORT_CARD handler falls back to the client's copy
    // for exactly that case. See GameState.epilogue.
    epilogue: "",
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
          sidebar_used_parent1, sidebar_used_parent2, sidebar_active, concern_level,
          highest_rung_fired, cps_outcome, therapy_messages, intervention_text, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15,
               $16, $17, $18::jsonb, $19, now())
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
         concern_level         = EXCLUDED.concern_level,
         highest_rung_fired    = EXCLUDED.highest_rung_fired,
         cps_outcome           = EXCLUDED.cps_outcome,
         therapy_messages      = EXCLUDED.therapy_messages,
         intervention_text     = EXCLUDED.intervention_text,
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
        state.concernLevel,
        state.highestRungFired,
        state.cpsOutcome,
        JSON.stringify(state.therapyMessages),
        state.interventionText,
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

  async savePlayer(gameId: string, slot: string, displayName: string, token: string, userId?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO players (game_id, slot, display_name, token, user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (game_id, slot) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         token        = EXCLUDED.token,
         user_id      = COALESCE(EXCLUDED.user_id, players.user_id)`,
      [gameId, slot, displayName, token, userId ?? null]
    );
  }

  async loadPlayers(gameId: string): Promise<PlayerRecord[]> {
    const res = await this.db.query<{
      slot: string;
      display_name: string;
      token: string;
      user_id: string | null;
    }>(
      `SELECT slot, display_name, token, user_id FROM players WHERE game_id = $1`,
      [gameId]
    );
    return res.rows.map((r) => ({
      slot: r.slot,
      displayName: r.display_name,
      token: r.token,
      userId: r.user_id ?? undefined,
    }));
  }

  async saveUserGame(userId: string, gameId: string, childName: string): Promise<void> {
    await this.db.query(
      `INSERT INTO user_games (user_id, game_id, child_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, game_id) DO NOTHING`,
      [userId, gameId, childName]
    );
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
      concern_level: number;
      highest_rung_fired: number;
      cps_outcome: "stay" | "safety_plan" | "removal" | null;
      therapy_messages: TherapyMessage[];
      intervention_text: string | null;
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
              sidebar_active,
              COALESCE(concern_level, 0) AS concern_level,
              COALESCE(highest_rung_fired, 0) AS highest_rung_fired,
              cps_outcome,
              COALESCE(therapy_messages, '[]'::jsonb) AS therapy_messages,
              intervention_text
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
      concernLevel: game.concern_level,
      highestRungFired: game.highest_rung_fired,
      cpsOutcome: game.cps_outcome,
      therapyMessages: game.therapy_messages,
      interventionText: game.intervention_text,
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

  async saveConcernEvent(event: { gameId: string; sender: Sender; reason: string; ipAddress: string | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO concern_events (game_id, sender, reason, ip_address) VALUES ($1, $2, $3, $4)`,
      [event.gameId, event.sender, event.reason, event.ipAddress]
    );
  }

  async loadConcernEvents(gameId: string): Promise<Array<{ sender: string; reason: string; createdAt: number }>> {
    const r = await this.db.query<{ sender: string; reason: string; created_at: string }>(
      `SELECT sender, reason, created_at FROM concern_events WHERE game_id = $1 ORDER BY created_at ASC`,
      [gameId]
    );
    return r.rows.map((row) => ({ sender: row.sender, reason: row.reason, createdAt: new Date(row.created_at).getTime() }));
  }

  async recordGameIp(gameId: string, ipAddress: string | null): Promise<void> {
    await this.db.query(`UPDATE games SET ip_address = $2 WHERE id = $1`, [gameId, ipAddress]);
  }

  async getIpPlayProfile(ipAddress: string): Promise<{ totalGames: number; darkGames: number; ordinaryGames: number }> {
    // darkGames: the game got genuinely dark — highest rung of the
    // intervention ladder fired, or net concern reached ESCALATION_DARK_CONCERN.
    // ordinaryGames: the game showed range — EITHER it reached a normal
    // ending (not a CPS removal) OR it ran along with low concern, no rung
    // fired, and progressed past the first couple of events (so a game that
    // never even got going isn't mistaken for "ordinary").
    // These two predicates are NOT required to be mutually exclusive or
    // exhaustive over all games — a game can be neither dark nor ordinary
    // (e.g. abandoned at event 1) — that's fine: isEscalation requires
    // darkGames === totalGames, so any such game already breaks escalation.
    const res = await this.db.query<{ total_games: string; dark_games: string; ordinary_games: string }>(
      `SELECT
         COUNT(*)::text AS total_games,
         COUNT(*) FILTER (
           WHERE highest_rung_fired > 0 OR concern_level >= $2
         )::text AS dark_games,
         COUNT(*) FILTER (
           WHERE (
             phase IN ('epilogue', 'ended', 'report_card', 'adult_chat')
             AND cps_outcome IS DISTINCT FROM 'removal'
           )
           OR (
             concern_level < $2
             AND highest_rung_fired = 0
             AND current_event_number >= 2
           )
         )::text AS ordinary_games
       FROM games
       WHERE ip_address = $1`,
      [ipAddress, ESCALATION_DARK_CONCERN]
    );
    const row = res.rows[0];
    return {
      totalGames: parseInt(row?.total_games ?? "0", 10),
      darkGames: parseInt(row?.dark_games ?? "0", 10),
      ordinaryGames: parseInt(row?.ordinary_games ?? "0", 10),
    };
  }

  async saveEscalationFlag(record: {
    ipAddress: string;
    gameId: string;
    totalGames: number;
    darkGames: number;
    ordinaryGames: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO escalation_flags (ip_address, game_id, total_games, dark_games, ordinary_games)
       VALUES ($1, $2, $3, $4, $5)`,
      [record.ipAddress, record.gameId, record.totalGames, record.darkGames, record.ordinaryGames]
    );
  }

  async hasEscalationFlagForIp(ipAddress: string): Promise<boolean> {
    const res = await this.db.query("SELECT 1 FROM escalation_flags WHERE ip_address = $1 LIMIT 1", [ipAddress]);
    return res.rows.length > 0;
  }

  async deleteUserData(userId: string): Promise<{ deletedGameIds: string[] }> {
    const linked = await this.db.query<{ game_id: string }>(
      "SELECT DISTINCT game_id FROM user_games WHERE user_id = $1",
      [userId]
    );
    const deletedGameIds = linked.rows.map((r) => r.game_id);

    if (deletedGameIds.length > 0) {
      // concern_events and escalation_flags have no FK to games (see
      // migrations 014/018), so they are not covered by the games row's
      // ON DELETE CASCADE and must be cleared explicitly.
      await this.db.query("DELETE FROM concern_events WHERE game_id = ANY($1::uuid[])", [deletedGameIds]);
      await this.db.query("DELETE FROM escalation_flags WHERE game_id = ANY($1::uuid[])", [deletedGameIds]);
      // Cascades to players, events, messages, identity_snapshots, endgames,
      // moderation_flags, album_moments, and the user_games rows themselves.
      await this.db.query("DELETE FROM games WHERE id = ANY($1::uuid[])", [deletedGameIds]);
    }
    // album_partners is keyed by user_id directly, not by game_id, so it
    // survives the games cascade above and needs its own delete.
    await this.db.query("DELETE FROM album_partners WHERE user_id = $1", [userId]);

    return { deletedGameIds };
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
      concernLevel: number;
      highestRungFired: number;
      cpsOutcome: "stay" | "safety_plan" | "removal" | null;
      therapyMessages: TherapyMessage[];
      interventionText: string | null;
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
  private concernEvents: Array<{ gameId: string; sender: Sender; reason: string; ipAddress: string | null; createdAt: number }> = [];
  // Dark Play Plan 4 — kept as a side map (not merged into the `games` row)
  // because saveGame replaces that row wholesale on every checkpoint and
  // ip_address is deliberately NOT part of GameState (see recordGameIp).
  private gameIpAddresses = new Map<string, string | null>();
  private escalationFlags: Array<{
    ipAddress: string;
    gameId: string;
    totalGames: number;
    darkGames: number;
    ordinaryGames: number;
    createdAt: number;
  }> = [];

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
      concernLevel: state.concernLevel,
      highestRungFired: state.highestRungFired,
      cpsOutcome: state.cpsOutcome,
      therapyMessages: state.therapyMessages.map((m) => ({ ...m })),
      interventionText: state.interventionText,
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

  async savePlayer(gameId: string, slot: string, displayName: string, token: string, userId?: string): Promise<void> {
    const map = this.playerRecords.get(gameId) ?? new Map<string, PlayerRecord>();
    const existing = map.get(slot);
    map.set(slot, { slot, displayName, token, userId: userId ?? existing?.userId });
    this.playerRecords.set(gameId, map);
  }

  async loadPlayers(gameId: string): Promise<PlayerRecord[]> {
    return [...(this.playerRecords.get(gameId)?.values() ?? [])];
  }

  async saveUserGame(userId: string, gameId: string, childName: string): Promise<void> {
    const key = `${userId}:${gameId}`;
    if (!this.userGames.has(key)) {
      this.userGames.set(key, { userId, gameId, childName, partnerId: null, createdAt: Date.now() });
    }
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
      concernLevel: game.concernLevel,
      highestRungFired: game.highestRungFired,
      cpsOutcome: game.cpsOutcome,
      therapyMessages: game.therapyMessages.map((m) => ({ ...m })),
      interventionText: game.interventionText,
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

  async saveConcernEvent(event: { gameId: string; sender: Sender; reason: string; ipAddress: string | null }): Promise<void> {
    this.concernEvents.push({ ...event, createdAt: Date.now() });
  }

  async loadConcernEvents(gameId: string): Promise<Array<{ sender: string; reason: string; createdAt: number }>> {
    return this.concernEvents
      .filter((e) => e.gameId === gameId)
      .map((e) => ({ sender: e.sender, reason: e.reason, createdAt: e.createdAt }));
  }

  async recordGameIp(gameId: string, ipAddress: string | null): Promise<void> {
    this.gameIpAddresses.set(gameId, ipAddress);
  }

  async getIpPlayProfile(ipAddress: string): Promise<{ totalGames: number; darkGames: number; ordinaryGames: number }> {
    let totalGames = 0;
    let darkGames = 0;
    let ordinaryGames = 0;
    for (const [gameId, game] of this.games) {
      if (this.gameIpAddresses.get(gameId) !== ipAddress) continue;
      totalGames++;

      const isDark = game.highestRungFired > 0 || game.concernLevel >= ESCALATION_DARK_CONCERN;
      if (isDark) darkGames++;

      const reachedNormalEnding =
        (["epilogue", "ended", "report_card", "adult_chat"] as GamePhase[]).includes(game.phase) &&
        game.cpsOutcome !== "removal";
      const lowConcernWithProgress =
        game.concernLevel < ESCALATION_DARK_CONCERN &&
        game.highestRungFired === 0 &&
        game.currentEventNumber >= 2;
      if (reachedNormalEnding || lowConcernWithProgress) ordinaryGames++;
    }
    return { totalGames, darkGames, ordinaryGames };
  }

  async saveEscalationFlag(record: {
    ipAddress: string;
    gameId: string;
    totalGames: number;
    darkGames: number;
    ordinaryGames: number;
  }): Promise<void> {
    this.escalationFlags.push({ ...record, createdAt: Date.now() });
  }

  async hasEscalationFlagForIp(ipAddress: string): Promise<boolean> {
    return this.escalationFlags.some((f) => f.ipAddress === ipAddress);
  }

  /** Test-only accessor — inspect persisted escalation flags without a DB. */
  getEscalationFlags(): Array<{
    ipAddress: string;
    gameId: string;
    totalGames: number;
    darkGames: number;
    ordinaryGames: number;
  }> {
    return this.escalationFlags.map(({ createdAt: _createdAt, ...rest }) => rest);
  }

  async deleteUserData(userId: string): Promise<{ deletedGameIds: string[] }> {
    const deletedGameIds = [...this.userGames.values()]
      .filter((ug) => ug.userId === userId)
      .map((ug) => ug.gameId);

    for (const gameId of deletedGameIds) {
      this.games.delete(gameId);
      this.messages.delete(gameId);
      this.events.delete(gameId);
      this.snapshots.delete(gameId);
      this.endgames.delete(gameId);
      this.playerRecords.delete(gameId);
      this.albumMoments.delete(gameId);
      this.gameIpAddresses.delete(gameId);
      this.moderationFlags = this.moderationFlags.filter((f) => f.gameId !== gameId);
      this.concernEvents = this.concernEvents.filter((e) => e.gameId !== gameId);
      this.escalationFlags = this.escalationFlags.filter((f) => f.gameId !== gameId);
      this.userGames.delete(`${userId}:${gameId}`);
      this.partnerLinks.delete(`${userId}:${gameId}`);
    }

    for (const [id, partner] of this.albumPartners) {
      if (partner.userId === userId) this.albumPartners.delete(id);
    }

    return { deletedGameIds };
  }
}
