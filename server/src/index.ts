import express from "express";
import cors from "cors";
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

async function main() {
  const app = express();
  app.use(cors());
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
  if (process.env.DATABASE_URL) {
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
  app.use("/api", createEndgameRoutes(endgameEngine, games));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Realtime multiplayer transport (M2/M3). The REST routes above remain for
  // solo play and reconnect; socket.io drives two-player games over the same
  // engines, games Map, and repository.
  const sessions = new Map<string, Session>();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, { cors: { origin: "*" } });
  registerSocketHandlers({
    io,
    games,
    sessions,
    conversationEngine,
    endgameEngine,
    repo,
  });

  const PORT = process.env.PORT || 3000;
  const server = httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  const shutdown = async () => {
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
