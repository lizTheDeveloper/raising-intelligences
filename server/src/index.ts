import { RoutingLLMClient } from "./llm/routing-client.js";
import type { LLMUsage } from "./llm/client.js";
import type { ModelTier } from "./llm/model-config.js";
import { TracedLLMClient, flushLangfuse, isLangfuseEnabled } from "./observability/langfuse.js";
import {
  type GameRepository,
  InMemoryGameRepository,
  PgGameRepository,
} from "./db/repository.js";
import type { AdminQueries } from "./db/admin-queries.js";
import { PgAdminQueries } from "./db/admin-queries.js";
import { buildServer } from "./app.js";
import { logger } from "./logger.js";

const REQUIRED_ENV_VARS = ["OPENROUTER_API_KEY"];

function validateConfig(): void {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error("missing_env_vars", { missing });
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" && !process.env.ALLOWED_ORIGIN) {
    logger.error("ALLOWED_ORIGIN must be set in production to avoid CORS defaulting to localhost");
    process.exit(1);
  }
}

async function main() {
  validateConfig();

  // OpenRouter (OpenAI-compatible) drives all LLM calls, selecting a model per
  // role and tier (see docs/monetization-strategy.md §3.1). Per-call token +
  // cost accounting is logged so per-game cost can be tracked (§3.2). The
  // Langfuse tracer wraps it transparently — a pass-through when no keys are set.
  // Default to cerebras if CEREBRAS_API_KEY is set, else standard.
  // Explicit MODEL_TIER always wins.
  const defaultTier = process.env.CEREBRAS_API_KEY ? "cerebras" : "standard";
  const rawTier = process.env.MODEL_TIER ?? defaultTier;
  const tier: ModelTier =
    rawTier === "premium" ? "premium" :
    rawTier === "cerebras" ? "cerebras" :
    "standard";
  const onUsage = (u: LLMUsage) => {
    logger.info("llm_usage", {
      role: u.role,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: Number(u.costUsd.toFixed(5)),
    });
  };
  const seed = process.env.LLM_SEED ? Number(process.env.LLM_SEED) : undefined;
  const llm = new TracedLLMClient(
    new RoutingLLMClient(tier, onUsage, "kid_family_chat", seed),
    {},
    tier
  );

  // Use Postgres when DATABASE_URL is configured; otherwise an in-memory
  // repository so the server runs with no external dependencies.
  let repo: GameRepository;
  let adminQueries: AdminQueries | undefined;
  const usingPostgres = !!process.env.DATABASE_URL;
  if (usingPostgres) {
    const { migrate } = await import("./db/migrate.js");
    await migrate();
    repo = new PgGameRepository();
    adminQueries = new PgAdminQueries();
    logger.info("persistence_mode", { mode: "postgres" });
  } else {
    repo = new InMemoryGameRepository();
    logger.info("persistence_mode", { mode: "in-memory", hint: "set DATABASE_URL to enable Postgres" });
  }

  logger.info("observability", { langfuse: isLangfuseEnabled() });

  // In production the app is deployed under the /raising-intelligences subpath.
  // Traefik has a dedicated router (ri-socket-io) that forwards
  // /raising-intelligences/socket.io WITHOUT stripping so the backend sees
  // the full path. Dev and tests use /socket.io.
  const socketPath =
    process.env.NODE_ENV === "production"
      ? "/raising-intelligences/socket.io"
      : "/socket.io";

  const { httpServer, close } = buildServer({
    llm,
    repo,
    adminQueries,
    serveStatic: process.env.NODE_ENV === "production",
    dbLabel: usingPostgres ? "postgres" : "in-memory",
    socketPath,
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

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    logger.info("server_started", { port: Number(PORT) });
  });

  const shutdown = async (signal: string) => {
    logger.info("shutdown_initiated", { signal });
    // Close all active connections (including in-flight SSE streams) before
    // tearing down socket.io. This lets tsx watch restart cleanly without
    // having to send SIGKILL, which would otherwise produce "socket hang-up"
    // 500 errors on the client during long LLM calls.
    httpServer.closeAllConnections();
    await close();
    await flushLangfuse();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("fatal_startup_error", { error: String(err) });
  process.exit(1);
});
