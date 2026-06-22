import { OpenRouterLLMClient } from "./llm/openrouter.js";
import type { LLMUsage } from "./llm/client.js";
import type { ModelTier } from "./llm/model-config.js";
import { TracedLLMClient, flushLangfuse, isLangfuseEnabled } from "./observability/langfuse.js";
import {
  type GameRepository,
  InMemoryGameRepository,
  PgGameRepository,
} from "./db/repository.js";
import { buildServer } from "./app.js";

const REQUIRED_ENV_VARS = ["OPENROUTER_API_KEY"];

function validateConfig(): void {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function main() {
  validateConfig();

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
  // A fixed LLM_SEED forwards a deterministic seed to OpenRouter (reproducible
  // output + prompt-cache hits); omit it in production for variety.
  const seed = process.env.LLM_SEED ? Number(process.env.LLM_SEED) : undefined;
  const llm = new TracedLLMClient(
    new OpenRouterLLMClient(tier, onUsage, "kid_family_chat", seed)
  );

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

  const { httpServer, app, close } = buildServer({
    llm,
    repo,
    serveStatic: process.env.NODE_ENV === "production",
    dbLabel: usingPostgres ? "postgres" : "in-memory",
    // When on Postgres, /health pings the DB to report real reachability.
    healthHandler: usingPostgres
      ? async (_req, res) => {
          try {
            const { pool } = await import("./db/pool.js");
            await pool.query("SELECT 1");
            res.json({ status: "ok", db: "postgres" });
          } catch {
            res.status(503).json({ status: "error", db: "unreachable" });
          }
        }
      : undefined,
  });

  // Serve per-game generated portraits (dynamic, not part of client build)
  const express = (await import("express")).default;
  const { PORTRAITS_DIR } = await import("./portrait-gen.js");
  app.use("/portraits", express.static(PORTRAITS_DIR));

  const PORT = process.env.PORT || 3000;
  const server = httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  const shutdown = async () => {
    await close();
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
