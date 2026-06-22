import pg from "pg";

const { Pool } = pg;

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/raising_intelligences";

/**
 * Shared connection pool for the application. Created lazily from
 * `DATABASE_URL` (falling back to the local docker-compose Postgres).
 */
export const pool = new Pool({ connectionString: DATABASE_URL });

/**
 * Convenience helper around `pool.query`. Returns the raw `pg` result.
 */
export function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<R>> {
  return pool.query<R>(text, params as never[]);
}
