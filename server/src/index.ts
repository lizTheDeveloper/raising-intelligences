import express from "express";
import cors from "cors";
import { createGameRoutes } from "./routes/game.js";
import { createEndgameRoutes } from "./routes/endgame.js";
import { ConversationEngine } from "./game/conversation-engine.js";
import { EndgameEngine } from "./game/endgame-engine.js";
import { ClaudeLLMClient } from "./llm/claude.js";
import { TracedLLMClient, flushLangfuse, isLangfuseEnabled } from "./observability/langfuse.js";
import {
  type GameRepository,
  InMemoryGameRepository,
  PgGameRepository,
} from "./db/repository.js";
import type { GameState } from "./types.js";

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Wrap the Claude client in the Langfuse tracer. When Langfuse env vars are
  // absent this is a transparent pass-through, so dev works without keys.
  const llm = new TracedLLMClient(new ClaudeLLMClient());
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

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
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
