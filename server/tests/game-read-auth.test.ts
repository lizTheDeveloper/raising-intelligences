import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import { TestClient, connect } from "./helpers/socket-client.js";
import type { GameEvent, Message } from "../src/types.js";

/**
 * Privacy review F1: every read of a game's content needs the reader's own
 * credential, and returns only what that reader may see.
 *
 * - GET /game/:id/state was open to anyone holding the game id. Both
 *   co-parents hold it (the invite link carries it), so either could read the
 *   other's private sidebar with the child, the confessional-derived
 *   personalitySeed and the memorySummary.
 * - GET /user/:userId/kids (and the album routes) were open to anyone who knew
 *   a Matrix handle.
 */

const ALICE = "@alice:multiversegames.ai";
const MALLORY = "@mallory:multiversegames.ai";
const TOKENS: Record<string, string> = { "tok-alice": ALICE, "tok-mallory": MALLORY };

const SIDEBAR = "SENTINEL-SIDEBAR-parent1-private-7c1e";
const SEED = "SENTINEL-SEED-from-confessionals-2b9d";
const MEMORY = "SENTINEL-MEMORY-summary-41aa";
const SHARED = "a shared line both parents saw";

function event(n: number): GameEvent {
  return { eventNumber: n, age: 4, description: `Scenario ${n}.`, setting: "Home", trigger: "Test" };
}

describe("game reads need the reader's credential (F1)", () => {
  let built: BuiltServer;
  let repo: InMemoryGameRepository;
  let api: string;
  let origin: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    const mock = new MockLLMClient();
    mock.events = [event(1), event(2)];
    repo = new InMemoryGameRepository();
    built = buildServer({
      llm: mock,
      repo,
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
      verifyMatrix: async (t) => (typeof t === "string" ? TOKENS[t] ?? null : null),
    });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
    api = `${origin}/api`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await built.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${api}${path}`, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  async function soloGame(): Promise<{ gameId: string; secret: string }> {
    const res = await post("/game", { childName: "Kai" });
    expect(res.status).toBe(200);
    return (await res.json()) as { gameId: string; secret: string };
  }

  /** Two seated co-parents (the invite-link flow), then a parent1 sidebar planted in the live state. */
  async function seatedGame() {
    const p1 = await connect(origin);
    clients.push(p1);
    const j1 = p1.once<{ gameId: string; playerToken: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Ilse", displayName: "Host" });
    const { gameId, playerToken: t1 } = await j1;
    const p2 = await connect(origin);
    clients.push(p2);
    const j2 = p2.once<{ playerToken: string }>(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId, displayName: "Partner" });
    const { playerToken: t2 } = await j2;
    const s = built.games.get(gameId)!;
    const now = Date.now();
    const messages: Message[] = [
      { sender: "parent1", content: SHARED, chatType: "shared", visibleTo: ["parent1", "parent2", "kid"], timestamp: now - 2, eventNumber: 1 },
      { sender: "parent1", content: SIDEBAR, chatType: "private", visibleTo: ["parent1", "kid"], timestamp: now - 1, eventNumber: 1 },
    ];
    built.games.set(gameId, { ...s, messages, personalitySeed: SEED, memorySummary: MEMORY, phase: "family_chat" });
    return { gameId, t1, t2 };
  }

  describe("GET /game/:id/state", () => {
    it("refuses a caller with no credential, and a wrong one", async () => {
      const { gameId } = await soloGame();
      expect((await get(`/game/${gameId}/state`)).status).toBe(403);
      expect((await get(`/game/${gameId}/state`, { "x-game-secret": "0".repeat(64) })).status).toBe(403);
      expect((await get(`/game/${gameId}/state`, { "x-player-token": "nope" })).status).toBe(403);
    });

    it("answers the solo player who holds the game secret", async () => {
      const { gameId, secret } = await soloGame();
      const res = await get(`/game/${gameId}/state`, { "x-game-secret": secret });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe(gameId);
      expect(Array.isArray(body.messages)).toBe(true);
      expect("memorySummary" in body).toBe(true);
      // Built from the confessionals; no client reads it.
      expect(body.personalitySeed).toBeUndefined();
    });

    it("still 404s a game that doesn't exist", async () => {
      expect((await get(`/game/00000000-0000-4000-8000-000000000000/state`)).status).toBe(404);
    });

    it("an unauthenticated caller gets none of a two-seat game", async () => {
      const { gameId } = await seatedGame();
      const res = await get(`/game/${gameId}/state`);
      expect(res.status).toBe(403);
      const raw = await res.text();
      for (const s of [SIDEBAR, SEED, MEMORY, SHARED]) expect(raw).not.toContain(s);
    });

    it("a co-parent never sees the other's sidebar, the seed or the memory summary", async () => {
      const { gameId, t2 } = await seatedGame();
      const res = await get(`/game/${gameId}/state`, { "x-player-token": t2 });
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).toContain(SHARED);
      expect(raw).not.toContain(SIDEBAR);
      expect(raw).not.toContain(SEED);
      expect(raw).not.toContain(MEMORY);
    });

    it("a parent sees their own sidebar, still without the seed or memory summary", async () => {
      const { gameId, t1 } = await seatedGame();
      const raw = await (await get(`/game/${gameId}/state`, { "x-player-token": t1 })).text();
      expect(raw).toContain(SIDEBAR);
      expect(raw).not.toContain(SEED);
      expect(raw).not.toContain(MEMORY);
    });

    it("one seat's token doesn't open another game", async () => {
      const a = await seatedGame();
      const b = await seatedGame();
      expect((await get(`/game/${b.gameId}/state`, { "x-player-token": a.t2 })).status).toBe(403);
    });
  });

  describe("a game made before secrets existed (legacy, seatless)", () => {
    // A legacy game has no credential anywhere: nothing the creator holds
    // (only the game id, in localStorage) can be verified. A claim therefore
    // mints a READ-ONLY credential: never an owner secret.
    async function legacyGame(): Promise<string> {
      const s = createGame("Old Kai", "solo parent");
      built.games.set(s.id, { ...s, messages: [{ sender: "parent1", content: "LEGACY-SENTINEL", chatType: "shared", visibleTo: ["parent1", "parent2", "kid"], timestamp: Date.now(), eventNumber: 1 }] });
      await repo.saveGame(built.games.get(s.id)!);
      return s.id;
    }
    const claim = (id: string) => post(`/game/${id}/claim`, {});

    it("is claimed once: the claim reads the game's own view, a second claim is refused", async () => {
      const id = await legacyGame();
      expect((await get(`/game/${id}/state`)).status).toBe(403);
      const first = await claim(id);
      expect(first.status).toBe(200);
      const { secret } = (await first.json()) as { secret: string };
      expect(typeof secret).toBe("string");
      expect((await claim(id)).status).toBe(403);
      const res = await get(`/game/${id}/state`, { "x-game-secret": secret });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("LEGACY-SENTINEL");
    });

    it("an attacker who knows only the game id can't delete it, link it, or read it once its player has claimed it", async () => {
      const id = await legacyGame();
      // The attacker claims first: the claimed credential reads, and does nothing else.
      const { secret } = (await (await claim(id)).json()) as { secret: string };
      const del = await fetch(`${api}/game/${id}`, { method: "DELETE", headers: { "x-game-secret": secret } });
      expect(del.status).toBe(403);
      expect(await repo.loadGame(id)).not.toBeNull();
      expect((await repo.getAccessSecretHash(id))).toBeNull(); // never an owner secret
      await post(`/user/${MALLORY}/kids`, [{ gameId: id, childName: "Old Kai", secret }], { "x-matrix-openid": "tok-mallory" });
      expect(await repo.isProvenUserGame(MALLORY, id)).toBe(false);
      expect((await get(`/game/${id}/state`, { "x-matrix-openid": "tok-mallory" })).status).toBe(403);

      // The other order: the player claimed first; the attacker gets nothing.
      const id2 = await legacyGame();
      expect((await claim(id2)).status).toBe(200);
      expect((await claim(id2)).status).toBe(403);
      const raw = await (await get(`/game/${id2}/state`)).text();
      expect(raw).not.toContain("LEGACY-SENTINEL");
    });

    it("each claim is logged, and the claim path closes when the migration window ends", async () => {
      const lines: string[] = [];
      const out = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { lines.push(String(c)); return true; }) as never);
      try {
        expect((await claim(await legacyGame())).status).toBe(200);
      } finally {
        out.mockRestore();
      }
      expect(lines.some((l) => l.includes("legacy_game_claimed"))).toBe(true);
      const saved = process.env.RI_LEGACY_CLAIM_UNTIL;
      process.env.RI_LEGACY_CLAIM_UNTIL = "2000-01-01T00:00:00Z";
      try {
        expect((await claim(await legacyGame())).status).toBe(403);
      } finally {
        if (saved === undefined) delete process.env.RI_LEGACY_CLAIM_UNTIL; else process.env.RI_LEGACY_CLAIM_UNTIL = saved;
      }
    });

    it("a game that already has a secret, or has seats, can't be claimed", async () => {
      const { gameId } = await soloGame();
      expect((await claim(gameId)).status).toBe(403);
      const seated = await seatedGame();
      expect((await claim(seated.gameId)).status).toBe(403);
    });
  });

  describe("kids and album are their owner's alone", () => {
    const auth = (tok: string) => ({ "x-matrix-openid": tok });

    it("GET /user/:userId/kids needs that user's own verified sign-in", async () => {
      const { gameId, secret } = await soloGame();
      expect((await post(`/user/${ALICE}/kids`, [{ gameId, childName: "Kai", secret }], auth("tok-alice"))).status).toBe(200);
      expect((await get(`/user/${ALICE}/kids`)).status).toBe(401);
      expect((await get(`/user/${ALICE}/kids`, auth("bogus"))).status).toBe(401);
      expect((await get(`/user/${ALICE}/kids`, auth("tok-mallory"))).status).toBe(403);
      const mine = await get(`/user/${ALICE}/kids`, auth("tok-alice"));
      expect(mine.status).toBe(200);
      expect(((await mine.json()) as Array<{ gameId: string }>).map((k) => k.gameId)).toEqual([gameId]);
    });

    it("POST /user/:userId/kids needs that user's own sign-in too", async () => {
      const { gameId, secret } = await soloGame();
      expect((await post(`/user/${ALICE}/kids`, [{ gameId, childName: "Kai", secret }])).status).toBe(401);
      expect((await post(`/user/${ALICE}/kids`, [{ gameId, childName: "Kai", secret }], auth("tok-mallory"))).status).toBe(403);
    });

    it("the album and a scrapbook need the owner's sign-in", async () => {
      const { gameId } = await soloGame();
      expect((await get(`/user/${ALICE}/album`)).status).toBe(401);
      expect((await get(`/user/${ALICE}/album`, auth("tok-mallory"))).status).toBe(403);
      expect((await get(`/user/${ALICE}/album`, auth("tok-alice"))).status).toBe(200);
      expect((await get(`/user/${ALICE}/album/kid/${gameId}`)).status).toBe(401);
      expect((await get(`/user/${ALICE}/album/kid/${gameId}`, auth("tok-mallory"))).status).toBe(403);
    });

    it("a signed-in owner resumes on another device: a kid synced WITH its secret reads by Matrix sign-in", async () => {
      const { gameId, secret } = await soloGame();
      await post(`/user/${ALICE}/kids`, [{ gameId, childName: "Kai", secret }], auth("tok-alice"));
      const res = await get(`/game/${gameId}/state`, auth("tok-alice"));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { id: string }).id).toBe(gameId);
    });

    it("listing someone else's game id under your own account grants nothing", async () => {
      const { gameId } = await soloGame();
      await repo.saveEndgame(gameId, "SENTINEL-EPILOGUE", "SENTINEL-REPORT");
      // Mallory knows the id but not the secret: the row lists, and opens nothing.
      expect((await post(`/user/${MALLORY}/kids`, [{ gameId, childName: "Kai" }], auth("tok-mallory"))).status).toBe(200);
      expect((await get(`/game/${gameId}/state`, auth("tok-mallory"))).status).toBe(403);
      const scrap = await get(`/user/${MALLORY}/album/kid/${gameId}`, auth("tok-mallory"));
      expect(scrap.status).toBe(404);
      expect(await scrap.text()).not.toContain("SENTINEL");
      // A wrong secret is no proof either.
      await post(`/user/${MALLORY}/kids`, [{ gameId, childName: "Kai", secret: "f".repeat(64) }], auth("tok-mallory"));
      expect((await get(`/game/${gameId}/state`, auth("tok-mallory"))).status).toBe(403);
    });

    it("a seated game never opens by Matrix sign-in alone (seats read with their own token)", async () => {
      const { gameId, t1 } = await seatedGame();
      await post(`/user/${ALICE}/kids`, [{ gameId, childName: "Ilse", playerToken: t1 }], auth("tok-alice"));
      expect((await get(`/game/${gameId}/state`, auth("tok-alice"))).status).toBe(403);
    });
  });
});
