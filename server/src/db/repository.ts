import type {
  GameEvent,
  GamePhase,
  GameState,
  Message,
  Sender,
} from "../types.js";
import { pool } from "./pool.js";
import type pg from "pg";

export interface IdentitySnapshot {
  eventNumber: number;
  document: string;
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
  relationshipType: string;
  currentEventNumber: number;
  totalEvents: number;
  identityDocument: string;
  events: GameEvent[];
  messages: Message[];
  identitySnapshots: IdentitySnapshot[];
  sidebarUsed: { parent1: boolean; parent2: boolean };
}): GameState {
  const currentEvent =
    input.events.find((e) => e.eventNumber === input.currentEventNumber) ??
    null;

  // Count parent messages belonging ONLY to the current event so reconnecting
  // players don't have all prior events' messages counted against their cap.
  // Messages created since migration 002 carry an eventNumber tag; older rows
  // default to 0 and won't match any real currentEventNumber > 0.
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
    relationshipType: input.relationshipType,
    currentEvent,
    currentEventNumber: input.currentEventNumber,
    totalEvents: input.totalEvents,
    identityDocument: input.identityDocument,
    identitySnapshots: input.identitySnapshots,
    events: input.events,
    messages: input.messages,
    parentMessageCount,
    sidebarUsed: input.sidebarUsed,
    sidebarActive: null,
    lastActivityAt: Date.now(),
  };
}

export class PgGameRepository implements GameRepository {
  constructor(private db: Pick<pg.Pool, "query"> = pool) {}

  async saveGame(state: GameState): Promise<void> {
    await this.db.query(
      `INSERT INTO games
         (id, child_name, relationship_type, phase, current_event_number,
          total_events, identity_document,
          sidebar_used_parent1, sidebar_used_parent2, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET
         child_name            = EXCLUDED.child_name,
         relationship_type     = EXCLUDED.relationship_type,
         phase                 = EXCLUDED.phase,
         current_event_number  = EXCLUDED.current_event_number,
         total_events          = EXCLUDED.total_events,
         identity_document     = EXCLUDED.identity_document,
         sidebar_used_parent1  = EXCLUDED.sidebar_used_parent1,
         sidebar_used_parent2  = EXCLUDED.sidebar_used_parent2,
         updated_at            = now()`,
      [
        state.id,
        state.childName,
        state.relationshipType,
        state.phase,
        state.currentEventNumber,
        state.totalEvents,
        state.identityDocument,
        state.sidebarUsed.parent1,
        state.sidebarUsed.parent2,
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

  async loadGame(gameId: string): Promise<GameState | null> {
    const gameRes = await this.db.query<{
      id: string;
      child_name: string;
      relationship_type: string;
      phase: GamePhase;
      current_event_number: number;
      total_events: number;
      identity_document: string;
      sidebar_used_parent1: boolean;
      sidebar_used_parent2: boolean;
    }>(
      `SELECT id, child_name, relationship_type, phase,
              current_event_number, total_events, identity_document,
              COALESCE(sidebar_used_parent1, false) AS sidebar_used_parent1,
              COALESCE(sidebar_used_parent2, false) AS sidebar_used_parent2
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
      relationshipType: game.relationship_type,
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
    });
  }
}

/**
 * In-memory implementation of GameRepository for tests and for running the
 * game without a Postgres connection. Mirrors PgGameRepository semantics:
 * upsert-by-id game checkpoints, append messages, upsert events/snapshots by
 * event number, single endgame per game.
 */
export class InMemoryGameRepository implements GameRepository {
  private games = new Map<
    string,
    {
      id: string;
      childName: string;
      relationshipType: string;
      phase: GamePhase;
      currentEventNumber: number;
      totalEvents: number;
      identityDocument: string;
      sidebarUsedParent1: boolean;
      sidebarUsedParent2: boolean;
    }
  >();
  private messages = new Map<string, Message[]>();
  private events = new Map<string, Map<number, GameEvent>>();
  private snapshots = new Map<string, Map<number, IdentitySnapshot>>();
  private endgames = new Map<string, { epilogue: string; reportCard: string }>();

  async saveGame(state: GameState): Promise<void> {
    this.games.set(state.id, {
      id: state.id,
      childName: state.childName,
      relationshipType: state.relationshipType,
      phase: state.phase,
      currentEventNumber: state.currentEventNumber,
      totalEvents: state.totalEvents,
      identityDocument: state.identityDocument,
      sidebarUsedParent1: state.sidebarUsed.parent1,
      sidebarUsedParent2: state.sidebarUsed.parent2,
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
      relationshipType: game.relationshipType,
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
    });
  }

  /** Test helper: read the persisted endgame, if any. */
  async getEndgame(
    gameId: string
  ): Promise<{ epilogue: string; reportCard: string } | null> {
    return this.endgames.get(gameId) ?? null;
  }
}
