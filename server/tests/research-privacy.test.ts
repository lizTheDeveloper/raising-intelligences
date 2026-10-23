import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository, PgGameRepository } from "../src/db/repository.js";

const portraitCalls: Array<{ gameId: string; liveAtCall: boolean }> = [];
let portraitProbe: ((gameId: string) => boolean) | null = null;
vi.mock("../src/portrait-gen.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/portrait-gen.js")>();
  return {
    ...orig,
    generateFirstPortrait: async (gameId: string) => {
      portraitCalls.push({ gameId, liveAtCall: portraitProbe ? portraitProbe(gameId) : true });
    },
  };
});

const SENTINEL = "SENTINEL-CONFESSION-research-privacy-71c2";

describe("research privacy: /state and deletion", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let repo: InMemoryGameRepository;

  beforeAll(async () => {
    const mock = new MockLLMClient();
    mock.events = [
      { eventNumber: 1, age: 4, description: "Your child is 4.", setting: "Kitchen", trigger: "Spill" },
    ];
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => built.httpServer.close(() => resolve()));
  });

  const json = { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.20" };

  async function makeGame(): Promise<{ gameId: string; secret: string }> {
    const res = await fetch(`${baseUrl}/game`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ childName: "Kai" }),
    });
    const body = (await res.json()) as { gameId: string; secret: string };
    const p = await fetch(`${baseUrl}/game/${body.gameId}/personality`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        ocean: [3, 3, 3, 3, 3],
        confessional1: SENTINEL,
        confessional2: SENTINEL,
        sender: "parent1",
      }),
    });
    expect(p.status).toBe(200);
    return body;
  }

  it("(a) GET /state never contains personalities, identity document or answer text", async () => {
    const { gameId } = await makeGame();
    const res = await fetch(`${baseUrl}/game/${gameId}/state`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).not.toHaveProperty("parentPersonalities");
    expect(body).not.toHaveProperty("identityDocument");
    expect(text).not.toContain(SENTINEL);
  });

  it("(b) DELETE without or with a wrong secret is 403 and leaves data intact", async () => {
    const { gameId } = await makeGame();
    const none = await fetch(`${baseUrl}/game/${gameId}`, { method: "DELETE" });
    expect(none.status).toBe(403);
    const wrong = await fetch(`${baseUrl}/game/${gameId}`, {
      method: "DELETE",
      headers: { "x-game-secret": "0".repeat(64) },
    });
    expect(wrong.status).toBe(403);
    expect(await repo.loadGame(gameId)).not.toBeNull();
    expect((await fetch(`${baseUrl}/game/${gameId}/state`)).status).toBe(200);
  });

  it("(c) DELETE with the right secret is 204 and /state is then 404", async () => {
    const { gameId, secret } = await makeGame();
    const res = await fetch(`${baseUrl}/game/${gameId}`, {
      method: "DELETE",
      headers: { "x-game-secret": secret },
    });
    expect(res.status).toBe(204);
    expect(await repo.loadGame(gameId)).toBeNull();
    expect(built.games.has(gameId)).toBe(false);
    expect((await fetch(`${baseUrl}/game/${gameId}/state`)).status).toBe(404);
  });
});

describe("deletion is not undone by in-flight gender inference", () => {
  it("keeps a deleted game deleted when inference resolves afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class GatedLLM extends MockLLMClient {
      async completeResponse(...args: Parameters<MockLLMClient["completeResponse"]>): Promise<string> {
        if (args[3] === "gender_inference") {
          await gate;
          return "girl";
        }
        return super.completeResponse(...args);
      }
    }
    const repo = new InMemoryGameRepository();
    const built = buildServer({ llm: new GatedLLM(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
    try {
      const res = await fetch(`${base}/game`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.21" },
        body: JSON.stringify({ childName: "Kai" }),
      });
      const { gameId, secret } = (await res.json()) as { gameId: string; secret: string };
      const del = await fetch(`${base}/game/${gameId}`, { method: "DELETE", headers: { "x-game-secret": secret } });
      expect(del.status).toBe(204);

      release();
      await new Promise((r) => setTimeout(r, 50)); // let the callback settle

      expect(built.games.has(gameId)).toBe(false);
      expect(await repo.loadGame(gameId)).toBeNull();
      expect((await fetch(`${base}/game/${gameId}/state`)).status).toBe(404);
    } finally {
      release();
      await new Promise<void>((resolve) => built.httpServer.close(() => resolve()));
    }
  });
});

describe("deletion racing the gender-inference save", () => {
  it("serializes the callback's save with DELETE so the row is not recreated", async () => {
    let releaseLlm!: () => void;
    const llmGate = new Promise<void>((r) => (releaseLlm = r));
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((r) => (releaseSave = r));
    let armed = false;
    let saveStarted!: () => void;
    const saveStartedP = new Promise<void>((r) => (saveStarted = r));
    class GatedLLM extends MockLLMClient {
      async completeResponse(...args: Parameters<MockLLMClient["completeResponse"]>): Promise<string> {
        if (args[3] === "gender_inference") {
          await llmGate;
          return "girl";
        }
        return super.completeResponse(...args);
      }
    }
    class GatedRepo extends InMemoryGameRepository {
      hasGame(id: string): boolean {
        return (this as unknown as { games: Map<string, unknown> }).games.has(id);
      }
      async saveGame(state: Parameters<InMemoryGameRepository["saveGame"]>[0]): Promise<void> {
        if (armed) {
          saveStarted();
          await saveGate;
        }
        return super.saveGame(state);
      }
    }
    const repo = new GatedRepo();
    const built = buildServer({ llm: new GatedLLM(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
    portraitCalls.length = 0;
    portraitProbe = (id) => built.games.has(id) && repo.hasGame(id);
    try {
      const res = await fetch(`${base}/game`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.22" },
        body: JSON.stringify({ childName: "Kai" }),
      });
      const { gameId, secret } = (await res.json()) as { gameId: string; secret: string };

      armed = true;
      releaseLlm();
      await saveStartedP; // callback is now inside the lock with its save pending
      const delP = fetch(`${base}/game/${gameId}`, { method: "DELETE", headers: { "x-game-secret": secret } });
      await new Promise((r) => setTimeout(r, 30));
      releaseSave();
      expect((await delP).status).toBe(204);
      await new Promise((r) => setTimeout(r, 30));

      expect(repo.hasGame(gameId)).toBe(false);
      expect(await repo.loadGame(gameId)).toBeNull();
      expect(built.games.has(gameId)).toBe(false);
      expect((await fetch(`${base}/game/${gameId}/state`)).status).toBe(404);
      // Any portrait kickoff must have happened while the game still existed.
      expect(portraitCalls.every((c) => c.liveAtCall)).toBe(true);
    } finally {
      releaseLlm();
      releaseSave();
      portraitProbe = null;
      await new Promise<void>((resolve) => built.httpServer.close(() => resolve()));
    }
  });
});

describe("PgGameRepository.deleteGameData (mock db)", () => {
  it("issues every delete inside one transaction on a single client", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql.replace(/\s+/g, " ").trim());
        return { rows: [] };
      },
      release: () => calls.push("RELEASE"),
    };
    const repo = new PgGameRepository({
      query: async () => {
        throw new Error("must not run outside the transaction");
      },
      connect: async () => client,
    } as never);
    await repo.deleteGameData("11111111-1111-1111-1111-111111111111");
    expect(calls[0]).toBe("BEGIN");
    expect(calls[calls.length - 2]).toBe("COMMIT");
    expect(calls[calls.length - 1]).toBe("RELEASE");
    const deletes = calls.filter((c) => c.startsWith("DELETE"));
    expect(deletes.some((c) => c.includes("concern_events"))).toBe(true);
    expect(deletes.some((c) => c.includes("escalation_flags"))).toBe(true);
    expect(deletes[deletes.length - 1]).toMatch(/DELETE FROM games WHERE id = \$1/);
  });

  it("rolls back and releases when a delete fails", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql.trim().split(/\s+/)[0]);
        if (sql.includes("escalation_flags")) throw new Error("boom");
        return { rows: [] };
      },
      release: () => calls.push("RELEASE"),
    };
    const repo = new PgGameRepository({ query: async () => ({ rows: [] }), connect: async () => client } as never);
    await expect(repo.deleteGameData("g")).rejects.toThrow("boom");
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(calls[calls.length - 1]).toBe("RELEASE");
  });
});

// Needs DATABASE_URL pointing at a database with all migrations applied.
describe.skipIf(!process.env.DATABASE_URL)("deleteGameData covers every game_id table (Postgres)", () => {
  it("leaves no row keyed to the deleted game in any table with a game_id column", async () => {
    const { pool } = await import("../src/db/pool.js");
    const repo = new PgGameRepository(pool);
    const { randomUUID } = await import("crypto");
    const gameId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO games (id, child_name, relationship_type, phase) VALUES ($1, 'Kai', 'co-parents', 'event_intro')`,
        [gameId],
      );
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT DISTINCT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = current_schema() AND c.column_name = 'game_id'
            AND t.table_type = 'BASE TABLE'`,
      );
      expect(tables.length).toBeGreaterThan(0);

      // Seed one row per table. Columns other than game_id are filled from
      // the catalog so a table added later is exercised without test edits.
      const seeded: string[] = [];
      for (const { table_name } of tables) {
        const { rows: cols } = await pool.query<{
          column_name: string; data_type: string; is_nullable: string; column_default: string | null;
        }>(
          `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = $1`,
          [table_name],
        );
        const names: string[] = [];
        const values: string[] = [];
        for (const c of cols) {
          if (c.column_name === "game_id") {
            names.push(c.column_name);
            values.push(`'${gameId}'`);
          } else if (c.is_nullable === "NO" && c.column_default === null) {
            names.push(c.column_name);
            values.push(placeholderFor(c.data_type));
          }
        }
        await pool.query(
          `INSERT INTO "${table_name}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${values.join(", ")})`,
        );
        seeded.push(table_name);
      }

      // followup_contacts has no game_id: it hangs off followup_links by pseudonym.
      // Seed a contact for the pseudonym of the seeded link, if that table exists.
      const { rows: linkRows } = await pool.query<{ pseudonym_id: string }>(
        `SELECT pseudonym_id FROM followup_links WHERE game_id = $1`, [gameId]);
      const pseudonym = linkRows[0]?.pseudonym_id;
      // Fail loudly: a missing link row would make every pseudonym assertion vacuous.
      expect(pseudonym, "followup_links row was not seeded for the game").toBeTruthy();
      await pool.query(
        `INSERT INTO followup_contacts (pseudonym_id, email, consent_followup, consent_ai_analysis, consented_at)
         VALUES ($1, 'x@example.com', true, true, 1)`, [pseudonym]);
      // Any table that references followup_links(pseudonym_id) must be cleaned too.
      const { rows: refs } = await pool.query<{ table_name: string; column_name: string }>(
        `SELECT cl.relname AS table_name, a.attname AS column_name
           FROM pg_constraint con
           JOIN pg_class cl ON cl.oid = con.conrelid
           JOIN pg_class ft ON ft.oid = con.confrelid
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = ANY (con.confkey)
          WHERE con.contype = 'f' AND ft.relname = 'followup_links' AND fa.attname = 'pseudonym_id'
            AND cl.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`);
      expect(refs.map((r) => r.table_name).sort()).toContain("followup_contacts");

      await repo.deleteGameData(gameId);

      for (const r of refs) {
        const { rows } = await pool.query(`SELECT 1 FROM "${r.table_name}" WHERE "${r.column_name}" = $1`, [pseudonym]);
        expect(rows, `table ${r.table_name} still has a row for the deleted game's pseudonym`).toHaveLength(0);
      }

      for (const t of seeded) {
        const { rows } = await pool.query(`SELECT 1 FROM "${t}" WHERE game_id = $1`, [gameId]);
        expect(rows, `table ${t} still has rows for the deleted game`).toHaveLength(0);
      }
    } finally {
      await pool.query(`DELETE FROM games WHERE id = $1`, [gameId]).catch(() => {});
    }
  });
});

function placeholderFor(dataType: string): string {
  switch (dataType) {
    case "integer": case "bigint": case "smallint": case "numeric": case "double precision": case "real":
      return "0";
    case "boolean":
      return "false";
    case "uuid":
      return "gen_random_uuid()";
    case "jsonb": case "json":
      return "'{}'";
    case "timestamp with time zone": case "timestamp without time zone":
      return "now()";
    default:
      return "'x'";
  }
}
