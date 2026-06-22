import type { Server, Socket } from "socket.io";
import type { GameState, Sender } from "../types.js";
import type { ConversationEngine } from "../game/conversation-engine.js";
import type { EndgameEngine } from "../game/endgame-engine.js";
import type { GameRepository } from "../db/repository.js";
import { createGame, PARENT_MESSAGE_CAP } from "../game/state-machine.js";
import {
  type Session,
  createSession,
  addPlayer,
  removePlayer,
  setReady,
  allReady,
  resetReady,
  getPlayer,
} from "../game/session-manager.js";
import {
  SOCKET_EVENTS as E,
  type CreateGamePayload,
  type JoinGamePayload,
  type ReadyPayload,
  type ParentMessagePayload,
  type AdultChatPayload,
  type LobbyState,
  type ViewerState,
} from "./protocol.js";

export interface SocketDeps {
  io: Server;
  games: Map<string, GameState>;
  sessions: Map<string, Session>;
  conversationEngine: ConversationEngine;
  endgameEngine: EndgameEngine;
  repo: GameRepository;
}

interface SocketData {
  gameId?: string;
  slot?: Sender;
}

/** Build the per-viewer projection of game state: identity doc removed,
 * messages filtered to what this slot is allowed to see. */
function viewerState(state: GameState, slot: Sender): ViewerState {
  const messages = state.messages.filter((m) => m.visibleTo.includes(slot));
  return {
    id: state.id,
    phase: state.phase,
    childName: state.childName,
    relationshipType: state.relationshipType,
    currentEvent: state.currentEvent,
    currentEventNumber: state.currentEventNumber,
    totalEvents: state.totalEvents,
    messages,
    parentMessageCount: state.parentMessageCount,
    messagesRemaining: PARENT_MESSAGE_CAP - state.parentMessageCount,
    sidebarActive: state.sidebarActive,
    sidebarUsed: state.sidebarUsed,
  };
}

function lobbyState(io: Server, session: Session): LobbyState {
  const room = io.sockets.adapter.rooms.get(session.gameId);
  const connectedIds = new Set<string>(room ? [...room] : []);
  return {
    gameId: session.gameId,
    players: session.players.map((p) => ({
      slot: p.slot,
      displayName: p.displayName,
      ready: p.ready,
      connected: connectedIds.has(p.connectionId),
    })),
  };
}

export function registerSocketHandlers(deps: SocketDeps): void {
  const { io, games, sessions, conversationEngine, endgameEngine, repo } = deps;

  /** Emit a tailored ViewerState to every connected socket in the room. */
  function broadcastState(gameId: string): void {
    const state = games.get(gameId);
    const session = sessions.get(gameId);
    if (!state || !session) return;
    for (const player of session.players) {
      io.to(player.connectionId).emit(E.STATE, viewerState(state, player.slot));
    }
  }

  function broadcastLobby(gameId: string): void {
    const session = sessions.get(gameId);
    if (!session) return;
    io.to(gameId).emit(E.LOBBY, lobbyState(io, session));
  }

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;

    function fail(message: string): void {
      socket.emit(E.ERROR, { error: message });
    }

    function currentState(): GameState | undefined {
      return data.gameId ? games.get(data.gameId) : undefined;
    }

    socket.on(E.CREATE_GAME, async (payload: CreateGamePayload) => {
      if (!payload?.childName) return fail("childName is required");
      const state = createGame(payload.childName, payload.relationshipType);
      games.set(state.id, state);
      await repo.saveGame(state);

      let session = createSession(state.id);
      const added = addPlayer(session, socket.id, payload.displayName);
      session = added.session;
      sessions.set(state.id, session);

      data.gameId = state.id;
      data.slot = added.player.slot;
      await socket.join(state.id);

      socket.emit(E.JOINED, { gameId: state.id, slot: added.player.slot });
      broadcastLobby(state.id);
    });

    socket.on(E.JOIN_GAME, async (payload: JoinGamePayload) => {
      const gameId = payload?.gameId;
      if (!gameId) return fail("gameId is required");

      let state = games.get(gameId);
      if (!state) {
        const loaded = await repo.loadGame(gameId);
        if (loaded) {
          games.set(gameId, loaded);
          state = loaded;
        }
      }
      if (!state) return fail("Game not found");

      let session = sessions.get(gameId) ?? createSession(gameId);
      let added;
      try {
        added = addPlayer(session, socket.id, payload.displayName);
      } catch {
        return fail("This game already has two players");
      }
      session = added.session;
      sessions.set(gameId, session);

      data.gameId = gameId;
      data.slot = added.player.slot;
      await socket.join(gameId);

      socket.emit(E.JOINED, { gameId, slot: added.player.slot });
      broadcastLobby(gameId);
      socket.emit(E.STATE, viewerState(state, added.player.slot));
    });

    socket.on(E.READY, async (payload: ReadyPayload) => {
      const gameId = data.gameId;
      const session = gameId ? sessions.get(gameId) : undefined;
      const state = currentState();
      if (!gameId || !session || !state) return fail("Not in a game");

      sessions.set(gameId, setReady(session, socket.id, !!payload?.ready));
      broadcastLobby(gameId);

      const updated = sessions.get(gameId)!;
      if (!allReady(updated)) return;

      try {
        if (state.phase === "event_intro") {
          const next = await conversationEngine.startEvent(state);
          games.set(next.id, next);
          if (next.currentEvent) await repo.saveEvent(next.id, next.currentEvent);
          await repo.saveGame(next);
          sessions.set(gameId, resetReady(updated));
          broadcastState(gameId);
          broadcastLobby(gameId);
        } else if (state.phase === "debrief") {
          const next = conversationEngine.endDebrief(state);
          games.set(next.id, next);
          await repo.saveGame(next);
          sessions.set(gameId, resetReady(updated));
          broadcastState(gameId);
          broadcastLobby(gameId);
        }
      } catch (err) {
        fail(String(err));
      }
    });

    socket.on(E.PARENT_MESSAGE, async (payload: ParentMessagePayload) => {
      const gameId = data.gameId;
      const slot = data.slot;
      const state = currentState();
      const session = gameId ? sessions.get(gameId) : undefined;
      if (!gameId || !slot || !state || !session) return fail("Not in a game");
      if (slot === "kid") return fail("Invalid sender");
      if (!payload?.content?.trim()) return;

      // During a sidebar only the initiating parent may speak.
      if (state.phase === "sidebar" && state.sidebarActive !== slot) {
        return fail("The other parent is in a private conversation");
      }

      // Stream kid chunks: to the room in shared chat, or only to the sidebar
      // participant during a private conversation.
      const inSidebar = state.phase === "sidebar";
      const emitChunk = (chunk: string) => {
        if (inSidebar) {
          socket.emit(E.KID_CHUNK, { text: chunk });
        } else {
          io.to(gameId).emit(E.KID_CHUNK, { text: chunk });
        }
      };

      try {
        const result = await conversationEngine.handleParentMessage(
          state,
          slot,
          payload.content.trim(),
          emitChunk
        );
        games.set(result.state.id, result.state);
        const tail = result.state.messages.slice(-2);
        for (const m of tail) await repo.saveMessage(result.state.id, m);
        await repo.saveGame(result.state);

        broadcastState(gameId);
        io.to(gameId).emit(E.MESSAGE_DONE, {});
      } catch (err) {
        fail(String(err));
      }
    });

    socket.on(E.START_SIDEBAR, () => {
      const gameId = data.gameId;
      const slot = data.slot;
      const state = currentState();
      if (!gameId || !slot || slot === "kid" || !state) return fail("Not in a game");
      try {
        const next = conversationEngine.startSidebar(state, slot);
        games.set(next.id, next);
        broadcastState(gameId);
      } catch (err) {
        fail(String(err));
      }
    });

    socket.on(E.END_SIDEBAR, () => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      try {
        const next = conversationEngine.endSidebar(state);
        games.set(next.id, next);
        broadcastState(gameId);
      } catch (err) {
        fail(String(err));
      }
    });

    socket.on(E.END_CHAT, async () => {
      const gameId = data.gameId;
      const state = currentState();
      const session = gameId ? sessions.get(gameId) : undefined;
      if (!gameId || !state || !session) return fail("Not in a game");
      try {
        const next = await conversationEngine.endFamilyChat(state);
        games.set(next.id, next);
        const snap = next.identitySnapshots[next.identitySnapshots.length - 1];
        if (snap) await repo.saveSnapshot(next.id, snap);
        await repo.saveGame(next);
        sessions.set(gameId, resetReady(session));
        broadcastState(gameId);
        broadcastLobby(gameId);
      } catch (err) {
        fail(String(err));
      }
    });

    socket.on(E.START_EPILOGUE, async () => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      try {
        const result = await endgameEngine.generateEpilogue(state);
        games.set(result.state.id, result.state);
        await repo.saveGame(result.state);
        broadcastState(gameId);
        io.to(gameId).emit(E.EPILOGUE, { epilogue: result.epilogue });
      } catch (err) {
        fail(String(err));
      }
    });

    socket.on(E.ADULT_CHAT, async (payload: AdultChatPayload) => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      if (!payload?.scenario) return fail("scenario is required");
      try {
        const next = await endgameEngine.startAdultConversation(state, payload.scenario);
        games.set(next.id, next);
        await repo.saveGame(next);
        broadcastState(gameId);
      } catch (err) {
        fail(String(err));
      }
    });

    socket.on(E.REPORT_CARD, async (payload: { epilogue?: string }) => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      try {
        const result = await endgameEngine.generateReportCard(state, payload?.epilogue ?? "");
        games.set(result.state.id, result.state);
        await repo.saveEndgame(result.state.id, payload?.epilogue ?? "", result.reportCard);
        await repo.saveGame(result.state);
        broadcastState(gameId);
        io.to(gameId).emit(E.REPORT_CARD_READY, { reportCard: result.reportCard });
      } catch (err) {
        fail(String(err));
      }
    });

    socket.on("disconnect", () => {
      const gameId = data.gameId;
      if (!gameId) return;
      const session = sessions.get(gameId);
      if (!session) return;
      // Keep the slot reservation only if no one else is around; otherwise free
      // it so the seat can be reclaimed. We free on disconnect and let reconnect
      // re-add — the game state itself persists in the games Map / repo.
      if (getPlayer(session, socket.id)) {
        const updated = removePlayer(session, socket.id);
        if (updated.players.length === 0) {
          sessions.delete(gameId);
        } else {
          sessions.set(gameId, updated);
          broadcastLobby(gameId);
        }
      }
    });
  });
}
