import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "net";
import express from "express";
import { createHash } from "crypto";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository, PgGameRepository } from "../src/db/repository.js";
import { newGameSecret, verifyGameSecret, requireGameSecret } from "../src/security/game-secret.js";

describe("newGameSecret / verifyGameSecret", () => {
  it("generates 32 random bytes as hex plus its SHA-256 hash", () => {
    const { secret, hash } = newGameSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(hash).not.toBe(secret);
    expect(newGameSecret().secret).not.toBe(secret);
  });

  it("verifies the right secret", () => {
    const { secret, hash } = newGameSecret();
    expect(verifyGameSecret(secret, hash)).toBe(true);
  });

  it("rejects wrong, empty, undefined secrets and a null hash", () => {
    const { secret, hash } = newGameSecret();
    expect(verifyGameSecret(newGameSecret().secret, hash)).toBe(false);
    expect(verifyGameSecret("", hash)).toBe(false);
    expect(verifyGameSecret(undefined, hash)).toBe(false);
    expect(verifyGameSecret(secret, null)).toBe(false);
    expect(verifyGameSecret("", null)).toBe(false);
    expect(verifyGameSecret(hash, hash)).toBe(false);
  });
});

const SECURED = "11111111-1111-4111-8111-111111111111";
const LEGACY = "22222222-2222-4222-8222-222222222222";

describe("requireGameSecret middleware", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  const repo = new InMemoryGameRepository();
  const good = newGameSecret();

  beforeAll(async () => {
    await repo.recordAccessSecretHash(SECURED, good.hash);
    const app = express();
    app.get("/g/:id", requireGameSecret(repo), (_req, res) => res.json({ ok: true }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const get = (id: string, secret?: string) =>
    fetch(`${baseUrl}/g/${id}`, { headers: secret ? { "x-game-secret": secret } : {} });

  it("passes with the right secret", async () => {
    const res = await get(SECURED, good.secret);
    expect(res.status).toBe(200);
  });

  it("403s with a wrong or missing secret", async () => {
    for (const s of [newGameSecret().secret, undefined]) {
      const res = await get(SECURED, s);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
  });

  it("403s for a non-UUID id without touching the repo", async () => {
    const spy = vi.spyOn(repo, "getAccessSecretHash");
    const res = await get("not-a-uuid", good.secret);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("403s for a legacy game with no stored hash even when a header is sent", async () => {
    const res = await get(LEGACY, newGameSecret().secret);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});

describe("POST /api/game returns a secret", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let repo: InMemoryGameRepository;

  beforeAll(async () => {
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: new MockLLMClient(), repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await built.close();
  });

  it("returns { gameId, secret } and stores only the hash", async () => {
    const res = await fetch(`${baseUrl}/api/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.78.0.1" },
      body: JSON.stringify({ childName: "Wren" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { gameId: string; secret: string };
    expect(json.secret).toMatch(/^[0-9a-f]{64}$/);
    const stored = await repo.getAccessSecretHash(json.gameId);
    expect(stored).toBe(createHash("sha256").update(json.secret).digest("hex"));
    expect(stored).not.toBe(json.secret);
    expect(verifyGameSecret(json.secret, stored)).toBe(true);
  });

  it("CORS preflight allows the x-game-secret header", async () => {
    const res = await fetch(`${baseUrl}/api/game`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://example.test",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-game-secret",
      },
    });
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("x-game-secret");
  });
});

describe("InMemoryGameRepository secret hash", () => {
  it("round-trips and is null for unknown games", async () => {
    const repo = new InMemoryGameRepository();
    expect(await repo.getAccessSecretHash("nope")).toBeNull();
    await repo.recordAccessSecretHash("g1", "abc");
    expect(await repo.getAccessSecretHash("g1")).toBe("abc");
  });
});

describe("PgGameRepository secret hash", () => {
  function stubDb(rows: unknown[] = []) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows };
      },
    } as unknown as ConstructorParameters<typeof PgGameRepository>[0];
    return { db, calls };
  }

  it("recordAccessSecretHash writes games.access_secret_hash", async () => {
    const { db, calls } = stubDb();
    await new PgGameRepository(db).recordAccessSecretHash("g1", "hashval");
    expect(calls[0].sql).toContain("UPDATE games SET access_secret_hash");
    expect(calls[0].params).toEqual(["g1", "hashval"]);
  });

  it("getAccessSecretHash reads the column, null when absent or NULL", async () => {
    const found = stubDb([{ access_secret_hash: "hashval" }]);
    expect(await new PgGameRepository(found.db).getAccessSecretHash("g1")).toBe("hashval");
    expect(found.calls[0].sql).toContain("access_secret_hash");
    expect(await new PgGameRepository(stubDb([]).db).getAccessSecretHash("g1")).toBeNull();
    expect(await new PgGameRepository(stubDb([{ access_secret_hash: null }]).db).getAccessSecretHash("g1")).toBeNull();
  });
});
