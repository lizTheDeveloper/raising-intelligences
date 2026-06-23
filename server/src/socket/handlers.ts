import type { Server, Socket } from "socket.io";
import type { GameState, Sender } from "../types.js";
import type { ConversationEngine } from "../game/conversation-engine.js";
import type { EndgameEngine } from "../game/endgame-engine.js";
import type { GameRepository } from "../db/repository.js";
import { createGame, PARENT_MESSAGE_CAP } from "../game/state-machine.js";
import { generateFirstPortrait, generateNextPortrait } from "../portrait-gen.js";
import {
  type Session,
  type PlayerSlot,
  createSession,
  addPlayer,
  setReady,
  allReady,
  resetReady,
  getPlayer,
  getPlayerByToken,
  reconnectPlayer,
  disconnectPlayer,
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
  gameLocks?: Map<string, Promise<void>>;
}

interface SocketData {
  gameId?: string;
  slot?: Sender;
}

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

function lobbyState(session: Session): LobbyState {
  return {
    gameId: session.gameId,
    players: session.players.map((p) => ({
      slot: p.slot,
      displayName: p.displayName,
      ready: p.ready,
      connected: p.connected,
    })),
  };
}

export function registerSocketHandlers(deps: SocketDeps): void {
  const { io, games, sessions, conversationEngine, endgameEngine, repo,
          gameLocks = new Map<string, Promise<void>>() } = deps;

  function withGameLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const prev = gameLocks.get(gameId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const settled = next.then(() => {}, () => {});
    settled.then(() => { if (gameLocks.get(gameId) === settled) gameLocks.delete(gameId); });
    gameLocks.set(gameId, settled);
    return next;
  }

  function broadcastState(gameId: string): void {
    const state = games.get(gameId);
    const session = sessions.get(gameId);
    if (!state || !session) return;
    for (const player of session.players) {
      if (player.connected) {
        io.to(player.connectionId).emit(E.STATE, viewerState(state, player.slot));
      }
    }
  }

  function broadcastLobby(gameId: string): void {
    const session = sessions.get(gameId);
    if (!session) return;
    io.to(gameId).emit(E.LOBBY, lobbyState(session));
  }

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;

    function fail(message: string): void {
      socket.emit(E.ERROR, { error: message });
    }

    function currentState(): GameState | undefined {
      return data.gameId ? games.get(data.gameId) : undefined;
    }

    // ---- CREATE_GAME ----
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

      await repo.savePlayer(state.id, added.player.slot, added.player.displayName, added.player.token);
      socket.emit(E.JOINED, { gameId: state.id, slot: added.player.slot, playerToken: added.player.token });
      broadcastLobby(state.id);
      generateFirstPortrait(state.id).catch(() => {});
    });

    // ---- JOIN_GAME (new join OR reconnect) ----
    socket.on(E.JOIN_GAME, async (payload: JoinGamePayload) => {
      const gameId = payload?.gameId;
      if (!gameId) return fail("gameId is required");

      // Load game state if not in memory
      let state = games.get(gameId);
      if (!state) {
        const loaded = await repo.loadGame(gameId);
        if (loaded) {
          games.set(gameId, loaded);
          state = loaded;
        }
      }
      if (!state) return fail("Game not found");

      // Restore session from DB if not in memory
      let session = sessions.get(gameId) ?? createSession(gameId);
      if (session.players.length === 0) {
        const dbPlayers = await repo.loadPlayers(gameId);
        for (const rec of dbPlayers) {
          session = {
            ...session,
            players: [
              ...session.players,
              {
                slot: rec.slot as PlayerSlot,
                connectionId: "",
                displayName: rec.displayName,
                ready: false,
                connected: false,
                token: rec.token,
              },
            ],
          };
        }
        sessions.set(gameId, session);
      }

      // Token-based reconnect: returning player reclaims their slot
      if (payload.playerToken) {
        const existing = getPlayerByToken(session, payload.playerToken);
        if (existing) {
          const reconnected = reconnectPlayer(session, payload.playerToken, socket.id);
          session = reconnected.session;
          sessions.set(gameId, session);
          data.gameId = gameId;
          data.slot = reconnected.player.slot;
          await socket.join(gameId);
          socket.emit(E.JOINED, { gameId, slot: reconnected.player.slot, playerToken: reconnected.player.token });
          broadcastLobby(gameId);
          socket.emit(E.STATE, viewerState(state, reconnected.player.slot));
          return;
        }
      }

      // New player: assign to first free slot
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

      await repo.savePlayer(gameId, added.player.slot, added.player.displayName, added.player.token);
      socket.emit(E.JOINED, { gameId, slot: added.player.slot, playerToken: added.player.token });
      broadcastLobby(gameId);
      socket.emit(E.STATE, viewerState(state, added.player.slot));
    });

    // ---- READY ----
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
        if (state.phase === "event_intro" && state.currentEvent === null) {
          const next = await conversationEngine.loadEvent(state);
          games.set(next.id, next);
          if (next.currentEvent) await repo.saveEvent(next.id, next.currentEvent);
          await repo.saveGame(next);
          sessions.set(gameId, resetReady(updated));
          broadcastState(gameId);
          broadcastLobby(gameId);
        } else if (state.phase === "event_intro" && state.currentEvent !== null) {
          const next = conversationEngine.beginChat(state);
          games.set(next.id, next);
          await repo.saveGame(next);
          sessions.set(gameId, resetReady(updated));
          broadcastState(gameId);
          broadcastLobby(gameId);
          generateNextPortrait(gameId).catch(() => {});
        } else if (state.phase === "debrief") {
          if (state.currentEventNumber >= state.totalEvents) {
            const emitChunk = (chunk: string) => {
              io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
            };
            const result = await endgameEngine.generateEpilogue(state, emitChunk);
            games.set(result.state.id, result.state);
            await repo.saveGame(result.state);
            sessions.set(gameId, resetReady(updated));
            broadcastState(gameId);
            broadcastLobby(gameId);
            io.to(gameId).emit(E.EPILOGUE, { epilogue: result.epilogue });
          } else {
            const next = conversationEngine.endDebrief(state);
            games.set(next.id, next);
            await repo.saveGame(next);
            sessions.set(gameId, resetReady(updated));
            broadcastState(gameId);
            broadcastLobby(gameId);
          }
        }
      } catch (err) {
        sessions.set(gameId, resetReady(updated));
        broadcastLobby(gameId);
        fail(String(err));
      }
    });

    // ---- PARENT_MESSAGE ----
    socket.on(E.PARENT_MESSAGE, (payload: ParentMessagePayload) => {
      const gameId = data.gameId;
      const slot = data.slot;
      if (!gameId || !slot) return fail("Not in a game");
      if (slot === "kid") return fail("Invalid sender");
      if (!payload?.content?.trim()) return;

      withGameLock(gameId, async () => {
        const state = currentState();
        const session = sessions.get(gameId);
        if (!state || !session) { fail("Not in a game"); return; }

        if (state.phase === "sidebar" && state.sidebarActive !== slot) {
          fail("The other parent is in a private conversation");
          return;
        }

        const inSidebar = state.phase === "sidebar";
        const emitChunk = (chunk: string) => {
          if (inSidebar) {
            socket.emit(E.KID_CHUNK, { text: chunk });
          } else {
            io.to(gameId).emit(E.KID_CHUNK, { text: chunk });
          }
        };

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
      }).catch((err) => fail(String(err)));
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

    socket.on(E.END_CHAT, () => {
      const gameId = data.gameId;
      if (!gameId) return fail("Not in a game");

      withGameLock(gameId, async () => {
        const state = currentState();
        const session = sessions.get(gameId);
        if (!state || !session) { fail("Not in a game"); return; }
        const emitChunk = (chunk: string) => {
          io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
        };
        const next = await conversationEngine.endFamilyChat(state, emitChunk);
        games.set(next.id, next);
        const snap = next.identitySnapshots[next.identitySnapshots.length - 1];
        if (snap) await repo.saveSnapshot(next.id, snap);
        await repo.saveGame(next);
        sessions.set(gameId, resetReady(session));
        io.to(gameId).emit(E.DOC_DONE, { documentType: "identity" });
        broadcastState(gameId);
        broadcastLobby(gameId);
      }).catch((err) => fail(String(err)));
    });

    socket.on(E.START_EPILOGUE, async () => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      try {
        const emitChunk = (chunk: string) => {
          io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
        };
        const result = await endgameEngine.generateEpilogue(state, emitChunk);
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
        const emitChunk = (chunk: string) => {
          io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
        };
        const result = await endgameEngine.generateReportCard(state, payload?.epilogue ?? "", emitChunk);
        games.set(result.state.id, result.state);
        await repo.saveEndgame(result.state.id, payload?.epilogue ?? "", result.reportCard);
        await repo.saveGame(result.state);
        broadcastState(gameId);
        io.to(gameId).emit(E.REPORT_CARD_READY, { reportCard: result.reportCard });
      } catch (err) {
        fail(String(err));
      }
    });

    // ---- DISCONNECT: mark disconnected, don't remove ----
    socket.on("disconnect", () => {
      const gameId = data.gameId;
      if (!gameId) return;
      const session = sessions.get(gameId);
      if (!session) return;
      if (getPlayer(session, socket.id)) {
        const updated = disconnectPlayer(session, socket.id);
        sessions.set(gameId, updated);
        if (updated.players.some((p) => p.connected)) {
          broadcastLobby(gameId);
        }
      }
    });
  });
}
