import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

/**
 * Reads `.sql` files from `migrations/` in sorted (lexical) order and applies
 * any that have not yet been recorded in `schema_migrations`. Each migration
 * runs inside its own transaction. Idempotent: re-running applies nothing new.
 */
export async function migrate(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const all = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  const applied = new Set(rows.map((r) => r.name));

  const newlyApplied: string[] = [];

  for (const name of all) {
    if (applied.has(name)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        name,
      ]);
      await client.query("COMMIT");
      newlyApplied.push(name);
      logger.info("migration_applied", { name });
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration failed (${name}): ${String(err)}`);
    } finally {
      client.release();
    }
  }

  if (newlyApplied.length === 0) {
    logger.info("migrations_up_to_date");
  }

  return newlyApplied;
}

// Runnable directly via `tsx src/db/migrate.ts`.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("migration_failed", { error: String(err) });
      return pool.end().finally(() => process.exit(1));
    });
}
