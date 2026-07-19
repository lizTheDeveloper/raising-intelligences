import type { Server, Socket } from "socket.io";
import type { GameState, Sender, ParentPersonality } from "../types.js";
import type { ConversationEngine } from "../game/conversation-engine.js";
import type { EndgameEngine } from "../game/endgame-engine.js";
import type { GameRepository } from "../db/repository.js";
import { createGame, PARENT_MESSAGE_CAP } from "../game/state-machine.js";
import { generateFirstPortrait, generateNextPortrait } from "../portrait-gen.js";
import { withGameLock } from "../lib/game-lock.js";
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
  type PersonalityPayload,
  type LobbyState,
  type ViewerState,
} from "./protocol.js";
import { generatePersonalitySeed } from "../game/personality.js";
import { moderateParentMessage, applyModerationBlock } from "../safety/moderation.js";
import { getSocketIp } from "../lib/client-ip.js";
import { buildSceneTranscript } from "../game/context-assembler.js";

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
    childGender: state.childGender,
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

  const lock = <T>(gameId: string, fn: () => Promise<T>) => withGameLock(gameLocks, gameId, fn);

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

  /**
   * End-of-chat helper: runs the psychologist / identity-doc flow, saves
   * snapshot + game, resets ready flags, and broadcasts updated state.
   *
   * This function is intentionally lock-free — callers must ensure
   * serialization themselves (either by calling from within an existing
   * `withGameLock` block, or wrapping the call in one).
   */
  async function endChat(gameId: string, ipAddress: string | null): Promise<void> {
    const state = games.get(gameId);
    const session = sessions.get(gameId);
    if (!state || !session) return;
    if (state.phase !== "family_chat") return;
    const emitChunk = (chunk: string) => {
      io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
    };
    const { state: next, groomingCheck } = await conversationEngine.endFamilyChat(state, emitChunk);
    const snap = next.identitySnapshots[next.identitySnapshots.length - 1];
    if (snap) await repo.saveSnapshot(next.id, snap);

    if (groomingCheck.flagged) {
      const lastParentMessage = [...next.messages].reverse().find((m) => m.sender !== "kid");
      await applyModerationBlock({
        repo,
        games,
        state: next,
        sender: lastParentMessage?.sender ?? "parent1",
        content: buildSceneTranscript(next),
        reason: groomingCheck.reason,
        ipAddress,
        banIp: "repeat-offender", // scene-level pattern check: flag + end session on 1st, permanent ban on a 2nd flag in another game -- see moderation.ts
      });
      io.to(gameId).emit(E.ERROR, { error: "This session has ended." });
      broadcastState(gameId);
      return;
    }

    games.set(next.id, next);
    await repo.saveGame(next);
    sessions.set(gameId, resetReady(session));
    io.to(gameId).emit(E.DOC_DONE, { documentType: "identity" });
    broadcastState(gameId);
    broadcastLobby(gameId);
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

      lock(gameId, async () => {
        const state = currentState();
        const session = sessions.get(gameId);
        if (!state || !session) { fail("Not in a game"); return; }

        if (state.phase === "sidebar" && state.sidebarActive !== slot) {
          fail("The other parent is in a private conversation");
          return;
        }

        const moderation = await moderateParentMessage({
          repo,
          games,
          state,
          sender: slot,
          content: payload.content.trim(),
          ipAddress: getSocketIp(socket),
        });
        if (moderation.blocked) {
          fail("This session has ended.");
          broadcastState(gameId);
          return;
        }

        const inSidebar = state.phase === "sidebar";
        const emitChunk = (chunk: string) => {
          const filtered = chunk.replace(/\[SCENE_END\]/g, "");
          if (!filtered) return;
          if (inSidebar) {
            socket.emit(E.KID_CHUNK, { text: filtered });
          } else {
            io.to(gameId).emit(E.KID_CHUNK, { text: filtered });
          }
        };

        const result = await conversationEngine.handleParentMessage(
          state,
          slot,
          payload.content.trim(),
          emitChunk
        );

        // Detect and strip the [SCENE_END] sentinel before saving/broadcasting
        const sceneEnded = result.kidResponse.includes("[SCENE_END]");
        if (sceneEnded) {
          result.kidResponse = result.kidResponse.replace(/\s*\[SCENE_END\]\s*/g, "").trim();
          const msgs = result.state.messages;
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg) {
            lastMsg.content = lastMsg.content.replace(/\s*\[SCENE_END\]\s*/g, "").trim();
          }
        }

        games.set(result.state.id, result.state);
        const tail = result.state.messages.slice(-2);
        for (const m of tail) await repo.saveMessage(result.state.id, m);
        await repo.saveGame(result.state);

        broadcastState(gameId);
        io.to(gameId).emit(E.MESSAGE_DONE, {});

        // Auto-end the scene if the kid ended it naturally or the cap is reached.
        // Skip during sidebar: emitting SCENE_ENDED mid-sidebar locks both clients
        // since the endChat phase guard returns early, leaving no recovery path.
        if (!inSidebar && (sceneEnded || result.state.parentMessageCount >= PARENT_MESSAGE_CAP)) {
          io.to(gameId).emit(E.SCENE_ENDED, {});
          await endChat(gameId, getSocketIp(socket));
        }
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

      lock(gameId, async () => {
        await endChat(gameId, getSocketIp(socket));
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

    // ---- SUBMIT_PERSONALITY ----
    socket.on(E.SUBMIT_PERSONALITY, (payload: PersonalityPayload) => {
      const gameId = data.gameId;
      const slot = data.slot;
      if (!gameId || !slot || slot === "kid") return fail("Not in a game");

      const { ocean, confessional1, confessional2 } = payload ?? {};

      // Validate ocean
      if (
        !Array.isArray(ocean) ||
        ocean.length !== 5 ||
        !ocean.every((v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4)
      ) {
        return fail("ocean must be an array of 5 integers each between 1 and 4");
      }

      const MAX_CONFESSIONAL_LENGTH = 500;
      if (
        (confessional1 !== undefined && (typeof confessional1 !== "string" || confessional1.length > MAX_CONFESSIONAL_LENGTH)) ||
        (confessional2 !== undefined && (typeof confessional2 !== "string" || confessional2.length > MAX_CONFESSIONAL_LENGTH))
      ) {
        return fail("confessionals must be strings of at most 500 characters");
      }

      const personality: ParentPersonality = {
        ocean: ocean as [number, number, number, number, number],
        confessional1: confessional1 ?? "",
        confessional2: confessional2 ?? "",
      };

      lock(gameId, async () => {
        const state = currentState();
        if (!state) { fail("Not in a game"); return; }

        const updatedState: GameState = {
          ...state,
          parentPersonalities: {
            ...state.parentPersonalities,
            [slot]: personality,
          },
        };
        games.set(gameId, updatedState);

        // Broadcast that this slot has submitted
        io.to(gameId).emit(E.PERSONALITY_SUBMITTED, { slot });

        // Determine readiness: solo needs only parent1; multiplayer needs both
        const isSolo =
          updatedState.relationshipType === "solo parent" ||
          updatedState.relationshipType === "solo";

        const parent1 = updatedState.parentPersonalities.parent1;
        const parent2 = updatedState.parentPersonalities.parent2;
        const allPersonalitiesReady = isSolo ? !!parent1 : !!(parent1 && parent2);

        if (allPersonalitiesReady && parent1) {
          const seed = await generatePersonalitySeed(
            conversationEngine.llm,
            updatedState.childName,
            parent1,
            isSolo ? undefined : parent2
          );
          const withSeed: GameState = { ...updatedState, personalitySeed: seed };
          games.set(gameId, withSeed);
          await repo.saveGame(withSeed);
          io.to(gameId).emit(E.PERSONALITY_SEED_READY, { personalitySeed: seed });
        } else {
          await repo.saveGame(updatedState);
        }
      }).catch((err) => fail(String(err)));
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
