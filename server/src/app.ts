import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import rateLimit from "express-rate-limit";
import type { RequestHandler, ErrorRequestHandler } from "express";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createGameRoutes } from "./routes/game.js";
import { createEndgameRoutes } from "./routes/endgame.js";
import { createUserRoutes } from "./routes/user.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createAlbumRoutes } from "./routes/album.js";
import { createSupportRoutes } from "./routes/support.js";
import type { AdminQueries } from "./db/admin-queries.js";
import { ConversationEngine } from "./game/conversation-engine.js";
import { EndgameEngine } from "./game/endgame-engine.js";
import type { LLMClient } from "./llm/client.js";
import { registerSocketHandlers } from "./socket/handlers.js";
import { PORTRAITS_DIR } from "./portrait-gen.js";
import { logger } from "./logger.js";
import { getSocketIp } from "./lib/client-ip.js";
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
  /** socket.io mount path. In production the client is served under
   * /raising-intelligences/; the Traefik ri-socket-io router forwards
   * /raising-intelligences/socket.io WITHOUT stripping so the backend
   * sees the full path. Dev and tests use the default /socket.io. */
  socketPath?: string;
  /** Custom /health handler (e.g. one that pings Postgres). Defaults to a
   * static `{ status: "ok", db: dbLabel }`. */
  healthHandler?: RequestHandler;
  /** Read-only analytics queries for the admin dashboard. */
  adminQueries?: AdminQueries;
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
    adminQueries,
  } = options;

  const app = express();
  app.set("trust proxy", 1);
  app.use(cors({ origin: allowedOrigin }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://analytics.multiversestudios.xyz"],
          // Inline styles used by React component library; Google Fonts stylesheet
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          // Portrait images arrive as data URIs and blob: URLs during generation
          imgSrc: ["'self'", "data:", "blob:"],
          // SSE and API calls go back to the same origin; analytics goes to the
          // configured domain if present.
          connectSrc: ["'self'", allowedOrigin, "https://analytics.multiversestudios.xyz"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          mediaSrc: ["'self'"],
        },
      },
      // crossOriginEmbedderPolicy blocks EventSource in some browsers when set
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(express.json());

  // Security headers — defense-in-depth against common browser-based attacks.
  const securityHeaders: RequestHandler = (_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  };
  app.use(securityHeaders);

  // Blocks every request from an IP banned by the safety moderation layer
  // (safety/moderation.ts) — checked before rate limiting so a banned IP
  // can't even burn a rate-limit slot.
  const ipBanCheck: RequestHandler = (req, res, next) => {
    repo.isIpBanned(req.ip ?? "").then(
      (banned) => {
        if (banned) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        next();
      },
      (err) => {
        // Fail open: a DB hiccup on the ban check must not take the whole
        // game down. The safety layer itself must not become a new outage.
        logger.error("ip_ban_check_failed", { error: err instanceof Error ? err.message : String(err) });
        next();
      }
    );
  };
  app.use(ipBanCheck);

  // Global rate limit: 200 req / min per IP. Catches broad abuse.
  app.use(rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false }));

  const conversationEngine = new ConversationEngine(llm);
  const endgameEngine = new EndgameEngine(llm);

  // Authoritative in-memory stores, shared by the REST routes and the socket
  // handlers so solo play and multiplayer operate on identical state.
  const games = new Map<string, GameState>();
  const sessions = new Map<string, Session>();

  // Tighter limits on LLM-triggering and game-creation endpoints.
  const llmRateLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
  const gameCreateLimit = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false });
  const supportCheckoutLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

  // Single shared lock map — prevents cross-module races between game.ts,
  // endgame.ts, and socket handlers operating on the same game concurrently.
  const gameLocks = new Map<string, Promise<void>>();

  app.use("/api", createGameRoutes(conversationEngine, games, repo, { llmRateLimit, gameCreateLimit, gameLocks }));
  app.use("/api", createEndgameRoutes(endgameEngine, games, repo, { llmRateLimit, gameLocks }));
  app.use("/api", createUserRoutes());
  app.use("/api", createAlbumRoutes(repo));
  app.use("/api", supportCheckoutLimit, createSupportRoutes());
  if (adminQueries) {
    app.use("/api", createAdminRoutes(adminQueries, repo));
  }

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

  // Global error handler — must have 4 params so Express recognises it as an
  // error-handling middleware. Never emits err.stack to clients.
  const errorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
    res.status(500).json({ error: "An internal error occurred" });
  };
  app.use(errorHandler);

  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, {
    cors: { origin: allowedOrigin },
    path: socketPath,
  });

  // Same ban list as the REST ipBanCheck — a banned IP can't open a
  // multiplayer socket connection either. Fails open on a DB hiccup.
  io.use((socket, next) => {
    repo.isIpBanned(getSocketIp(socket)).then(
      (banned) => {
        if (banned) {
          next(new Error("Forbidden"));
          return;
        }
        next();
      },
      (err) => {
        logger.error("ip_ban_check_failed", { error: err instanceof Error ? err.message : String(err) });
        next();
      }
    );
  });

  registerSocketHandlers({
    io,
    games,
    sessions,
    conversationEngine,
    endgameEngine,
    repo,
    gameLocks,
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
