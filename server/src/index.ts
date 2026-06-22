import express from "express";
import cors from "cors";
import path from "path";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { createGameRoutes } from "./routes/game.js";
import { createEndgameRoutes } from "./routes/endgame.js";
import { ConversationEngine } from "./game/conversation-engine.js";
import { EndgameEngine } from "./game/endgame-engine.js";
import { OpenRouterLLMClient } from "./llm/openrouter.js";
import type { LLMUsage } from "./llm/client.js";
import type { ModelTier } from "./llm/model-config.js";
import { TracedLLMClient, flushLangfuse, isLangfuseEnabled } from "./observability/langfuse.js";
import {
  type GameRepository,
  InMemoryGameRepository,
  PgGameRepository,
} from "./db/repository.js";
import { registerSocketHandlers } from "./socket/handlers.js";
import type { Session } from "./game/session-manager.js";
import type { GameState } from "./types.js";

const REQUIRED_ENV_VARS = ["OPENROUTER_API_KEY"];
const GAME_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const EVICTION_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function validateConfig(): void {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function main() {
  validateConfig();

  const app = express();

  const allowedOrigin = process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";
  app.use(cors({ origin: allowedOrigin }));
  app.use(express.json());

  // OpenRouter (OpenAI-compatible) drives all LLM calls, selecting a model per
  // role and tier (see docs/monetization-strategy.md §3.1). Per-call token +
  // cost accounting is logged so per-game cost can be tracked (§3.2). The
  // Langfuse tracer wraps it transparently — a pass-through when no keys are set.
  const tier: ModelTier = process.env.MODEL_TIER === "premium" ? "premium" : "standard";
  const onUsage = (u: LLMUsage) => {
    console.log(
      `[llm] role=${u.role} model=${u.model} in=${u.inputTokens} out=${u.outputTokens} cost=$${u.costUsd.toFixed(5)}`
    );
  };
  const llm = new TracedLLMClient(new OpenRouterLLMClient(tier, onUsage));
  const conversationEngine = new ConversationEngine(llm);
  const endgameEngine = new EndgameEngine(llm);

  // Authoritative in-memory store, shared by both route groups.
  const games = new Map<string, GameState>();

  // Use Postgres when DATABASE_URL is configured; otherwise an in-memory
  // repository so the server runs with no external dependencies.
  let repo: GameRepository;
  const usingPostgres = !!process.env.DATABASE_URL;
  if (usingPostgres) {
    const { migrate } = await import("./db/migrate.js");
    await migrate();
    repo = new PgGameRepository();
    console.log("Persistence: Postgres (write-through)");
  } else {
    repo = new InMemoryGameRepository();
    console.log("Persistence: in-memory (set DATABASE_URL to enable Postgres)");
  }

  console.log(`Observability: Langfuse ${isLangfuseEnabled() ? "enabled" : "disabled"}`);

  app.use("/api", createGameRoutes(conversationEngine, games, repo));
  app.use("/api", createEndgameRoutes(endgameEngine, games, repo));

  // Serve per-game generated portraits (dynamic, not part of client build)
  const { PORTRAITS_DIR } = await import("./portrait-gen.js");
  app.use("/portraits", express.static(PORTRAITS_DIR));

  app.get("/health", async (_req, res) => {
    if (!usingPostgres) {
      res.json({ status: "ok", db: "in-memory" });
      return;
    }
    try {
      const { pool } = await import("./db/pool.js");
      await pool.query("SELECT 1");
      res.json({ status: "ok", db: "postgres" });
    } catch {
      res.status(503).json({ status: "error", db: "unreachable" });
    }
  });

  if (process.env.NODE_ENV === "production") {
    const clientDist = path.join(process.cwd(), "client", "dist");
    app.use(express.static(clientDist));
    app.get("/*path", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  // Realtime multiplayer transport (M2/M3). The REST routes above remain for
  // solo play and reconnect; socket.io drives two-player games over the same
  // engines, games Map, and repository.
  const sessions = new Map<string, Session>();
  const httpServer = createServer(app);
  const socketPath =
    process.env.NODE_ENV === "production" ? "/raising-intelligences/socket.io" : "/socket.io";
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

  // Evict ended or long-idle games from the in-memory Map to prevent unbounded
  // heap growth. Persisted games can always be reconstructed from the DB on
  // reconnect; in-memory-only games (no DATABASE_URL) are intentionally ephemeral.
  const evictionTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of games) {
      if (state.phase === "ended" || now - state.lastActivityAt > GAME_TTL_MS) {
        games.delete(id);
      }
    }
  }, EVICTION_INTERVAL_MS);
  evictionTimer.unref();

  const PORT = process.env.PORT || 3000;
  const server = httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  const shutdown = async () => {
    clearInterval(evictionTimer);
    await flushLangfuse();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
