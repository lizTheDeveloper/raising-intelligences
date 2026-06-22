import express from "express";
import cors from "cors";
import path from "path";
import type { RequestHandler } from "express";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createGameRoutes } from "./routes/game.js";
import { createEndgameRoutes } from "./routes/endgame.js";
import { ConversationEngine } from "./game/conversation-engine.js";
import { EndgameEngine } from "./game/endgame-engine.js";
import type { LLMClient } from "./llm/client.js";
import { registerSocketHandlers } from "./socket/handlers.js";
import { PORTRAITS_DIR } from "./portrait-gen.js";
import type { GameRepository } from "./db/repository.js";
import type { Session } from "./game/session-manager.js";
import type { GameState } from "./types.js";

const GAME_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const EVICTION_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export interface BuildServerOptions {
  /** The (already-wrapped, e.g. traced) LLM client driving every engine call. */
  llm: LLMClient;
  /** Persistence backend (Postgres or in-memory). */
  repo: GameRepository;
  allowedOrigin?: string;
  /** Whether to serve the built client bundle (production only). */
  serveStatic?: boolean;
  /** Whether the in-memory eviction sweep runs. Tests disable it. */
  enableEviction?: boolean;
  /** Reported by /health to describe the persistence backend. */
  dbLabel?: string;
  /** socket.io mount path. In production the app is deployed under a subpath
   * (/raising-intelligences/socket.io) that the client dials; tests and dev use
   * the default /socket.io. Defaults to the NODE_ENV-derived value. */
  socketPath?: string;
  /** Custom /health handler (e.g. one that pings Postgres). Defaults to a
   * static `{ status: "ok", db: dbLabel }`. */
  healthHandler?: RequestHandler;
}

/**
 * Everything the integrator (production `index.ts`) and the integration/E2E
 * test harness need to drive the app: the wired express app, the HTTP +
 * socket.io servers, the shared authoritative stores, the engines, and a
 * `close()` that tears down timers and sockets cleanly.
 */
export interface BuiltServer {
  app: express.Express;
  httpServer: HttpServer;
  io: SocketServer;
  games: Map<string, GameState>;
  sessions: Map<string, Session>;
  conversationEngine: ConversationEngine;
  endgameEngine: EndgameEngine;
  repo: GameRepository;
  close: () => Promise<void>;
}

/**
 * Wire the full application around an injected LLM client and repository. This
 * is the single source of truth for how routes, sockets, engines, and the
 * shared in-memory stores fit together — production and tests both build the
 * exact same stack, so the integration suite exercises real wiring rather than
 * a reconstruction of it.
 */
export function buildServer(options: BuildServerOptions): BuiltServer {
  const {
    llm,
    repo,
    allowedOrigin = process.env.ALLOWED_ORIGIN ?? "http://localhost:5173",
    serveStatic = process.env.NODE_ENV === "production",
    enableEviction = true,
    dbLabel = "in-memory",
    socketPath = process.env.NODE_ENV === "production"
      ? "/raising-intelligences/socket.io"
      : "/socket.io",
    healthHandler,
  } = options;

  const app = express();
  app.use(cors({ origin: allowedOrigin }));
  app.use(express.json());

  const conversationEngine = new ConversationEngine(llm);
  const endgameEngine = new EndgameEngine(llm);

  // Authoritative in-memory stores, shared by the REST routes and the socket
  // handlers so solo play and multiplayer operate on identical state.
  const games = new Map<string, GameState>();
  const sessions = new Map<string, Session>();

  app.use("/api", createGameRoutes(conversationEngine, games, repo));
  app.use("/api", createEndgameRoutes(endgameEngine, games, repo));

  app.get(
    "/health",
    healthHandler ?? ((_req, res) => res.json({ status: "ok", db: dbLabel }))
  );

  // Per-game generated portraits (dynamic, not part of the client build). Must
  // be registered before the SPA catch-all below, or Express 5 would let the
  // catch-all answer /portraits/*.png with index.html.
  app.use("/portraits", express.static(PORTRAITS_DIR));

  if (serveStatic) {
    const clientDist = path.join(process.cwd(), "client", "dist");
    app.use(express.static(clientDist));
    app.get("/*path", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, {
    cors: { origin: allowedOrigin },
    path: socketPath,
  });
  registerSocketHandlers({
    io,
    games,
    sessions,
    conversationEngine,
    endgameEngine,
    repo,
  });

  let evictionTimer: NodeJS.Timeout | undefined;
  if (enableEviction) {
    evictionTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, state] of games) {
        if (state.phase === "ended" || now - state.lastActivityAt > GAME_TTL_MS) {
          games.delete(id);
        }
      }
    }, EVICTION_INTERVAL_MS);
    evictionTimer.unref();
  }

  async function close(): Promise<void> {
    if (evictionTimer) clearInterval(evictionTimer);
    // io.close() disconnects all clients and closes the underlying HTTP server,
    // so there is no need to close httpServer separately.
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }

  return {
    app,
    httpServer,
    io,
    games,
    sessions,
    conversationEngine,
    endgameEngine,
    repo,
    close,
  };
}
