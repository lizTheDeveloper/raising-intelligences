import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { EndgameEngine } from "../src/game/endgame-engine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { registerSocketHandlers } from "../src/socket/handlers.js";
import { generateMultiplayerAlbums } from "../src/game/album-generator.js";
import { createGame } from "../src/game/state-machine.js";
import type { Session } from "../src/game/session-manager.js";
import type { GameState } from "../src/types.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";

function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe("multiplayer partner album", () => {
  describe("userId threading (task 1)", () => {
    let httpServer: HttpServer;
    let io: SocketServer;
    let port: number;
    let repo: InMemoryGameRepository;
    let sessions: Map<string, Session>;
    let p1: ClientSocket;
    let p2: ClientSocket;

    beforeEach(async () => {
      const mock = new MockLLMClient();
      repo = new InMemoryGameRepository();
      sessions = new Map<string, Session>();
      httpServer = createServer();
      io = new SocketServer(httpServer);
      registerSocketHandlers({
        io,
        games: new Map<string, GameState>(),
        sessions,
        conversationEngine: new ConversationEngine(mock),
        endgameEngine: new EndgameEngine(mock),
        repo,
      });
      await new Promise<void>((resolve) => httpServer.listen(() => resolve()));
      port = (httpServer.address() as { port: number }).port;
    });

    afterEach(() => {
      p1?.close();
      p2?.close();
      io.close();
      httpServer.close();
    });

    it("stores each player's userId on the session and persists it", async () => {
      p1 = ioClient(`http://localhost:${port}`);
      await waitFor(p1, "connect");
      const joined1 = waitFor<{ gameId: string }>(p1, E.JOINED);
      p1.emit(E.CREATE_GAME, { childName: "Nova", displayName: "Alex", userId: "@alex:server.org" });
      const { gameId } = await joined1;

      p2 = ioClient(`http://localhost:${port}`);
      await waitFor(p2, "connect");
      const joined2 = waitFor(p2, E.JOINED);
      p2.emit(E.JOIN_GAME, { gameId, displayName: "Sam", userId: "@sam:server.org" });
      await joined2;

      // Persisted to the repository (players.user_id column).
      const players = await repo.loadPlayers(gameId);
      const bySlot = Object.fromEntries(players.map((r) => [r.slot, r.userId]));
      expect(bySlot["parent1"]).toBe("@alex:server.org");
      expect(bySlot["parent2"]).toBe("@sam:server.org");

      // Held on the in-memory session player objects.
      const sessionPlayers = sessions.get(gameId)!.players;
      expect(sessionPlayers.find((p) => p.slot === "parent1")!.userId).toBe("@alex:server.org");
      expect(sessionPlayers.find((p) => p.slot === "parent2")!.userId).toBe("@sam:server.org");
    });

    it("leaves userId undefined for a non-logged-in player", async () => {
      p1 = ioClient(`http://localhost:${port}`);
      await waitFor(p1, "connect");
      const joined1 = waitFor<{ gameId: string }>(p1, E.JOINED);
      p1.emit(E.CREATE_GAME, { childName: "Nova", displayName: "Guest" });
      const { gameId } = await joined1;

      const players = await repo.loadPlayers(gameId);
      expect(players[0].userId).toBeUndefined();
    });
  });

  describe("album generation (task 2 + 3)", () => {
    let repo: InMemoryGameRepository;
    let engine: EndgameEngine;
    let state: GameState;

    beforeEach(() => {
      const mock = new MockLLMClient();
      // The mock returns this regardless of input. The saved partner name must
      // come from the co-parent's real display name, NOT this generated field.
      mock.albumData = {
        partnerName: "GENERATED_NAME_SHOULD_BE_IGNORED",
        relationshipSummary: "Two devoted co-parents who raised Nova together.",
        moments: [
          { age: 5, title: "First bike ride", description: "Wobbly but proud.", momentType: "milestone", visualPrompt: "a child on a bike" },
          { age: 12, title: "Science fair", description: "A volcano that actually erupted.", momentType: "achievement", visualPrompt: "a science fair volcano" },
        ],
      };
      repo = new InMemoryGameRepository();
      engine = new EndgameEngine(mock);
      state = createGame("Nova"); // co-parents relationship, real UUID id
    });

    it("groups the game under each player's co-parent with the correct partner name", async () => {
      const saveAlbumPartner = vi.spyOn(repo, "saveAlbumPartner");

      await generateMultiplayerAlbums({
        engine,
        repo,
        state,
        epilogue: "Nova grew up thoughtful.",
        reportCard: "# Nova",
        players: [
          { userId: "@alex:server.org", displayName: "Alex" },
          { userId: "@sam:server.org", displayName: "Sam" },
        ],
      });

      // saveAlbumPartner called once per logged-in player, with the co-parent's
      // real display name (not the LLM-generated placeholder).
      const savedNames = saveAlbumPartner.mock.calls.map((c) => c[0].partnerName).sort();
      expect(savedNames).toEqual(["Alex", "Sam"]);
      expect(savedNames).not.toContain("GENERATED_NAME_SHOULD_BE_IGNORED");

      // Alex's album: game grouped under partner "Sam", kid linked.
      const alexAlbum = await repo.loadAlbum("@alex:server.org");
      expect(alexAlbum.partners).toHaveLength(1);
      expect(alexAlbum.partners[0].partnerName).toBe("Sam");
      expect(alexAlbum.partners[0].partnerType).toBe("real");
      expect(alexAlbum.partners[0].kids.map((k) => k.gameId)).toContain(state.id);
      expect(alexAlbum.partners[0].kids[0].childName).toBe("Nova");
      expect(alexAlbum.unlinkedKids).toHaveLength(0);

      // Sam sees Alex as their partner — symmetric grouping.
      const samAlbum = await repo.loadAlbum("@sam:server.org");
      expect(samAlbum.partners).toHaveLength(1);
      expect(samAlbum.partners[0].partnerName).toBe("Alex");
      expect(samAlbum.partners[0].kids.map((k) => k.gameId)).toContain(state.id);
    });

    it("generates the shared scrapbook moments once, not per player", async () => {
      await generateMultiplayerAlbums({
        engine,
        repo,
        state,
        epilogue: "e",
        reportCard: "r",
        players: [
          { userId: "@alex:server.org", displayName: "Alex" },
          { userId: "@sam:server.org", displayName: "Sam" },
        ],
      });

      // Moments are keyed by game_id and shared — exactly the 2 defined, not 4.
      const scrapbook = await repo.loadScrapbook("@alex:server.org", state.id);
      expect(scrapbook?.moments).toHaveLength(2);
    });

    it("skips players with no userId and still groups the logged-in player under their co-parent", async () => {
      await generateMultiplayerAlbums({
        engine,
        repo,
        state,
        epilogue: "e",
        reportCard: "r",
        players: [
          { userId: "@alex:server.org", displayName: "Alex" },
          { userId: undefined, displayName: "Guest" },
        ],
      });

      const alexAlbum = await repo.loadAlbum("@alex:server.org");
      expect(alexAlbum.partners).toHaveLength(1);
      expect(alexAlbum.partners[0].partnerName).toBe("Guest");

      // The guest has no album entry.
      const guestAlbum = await repo.loadAlbum("Guest");
      expect(guestAlbum.partners).toHaveLength(0);
      expect(guestAlbum.unlinkedKids).toHaveLength(0);
    });

    it("does nothing when no player is logged in", async () => {
      const saveAlbumPartner = vi.spyOn(repo, "saveAlbumPartner");
      await generateMultiplayerAlbums({
        engine,
        repo,
        state,
        epilogue: "e",
        reportCard: "r",
        players: [
          { userId: undefined, displayName: "Guest 1" },
          { userId: undefined, displayName: "Guest 2" },
        ],
      });
      expect(saveAlbumPartner).not.toHaveBeenCalled();
    });
  });
});
