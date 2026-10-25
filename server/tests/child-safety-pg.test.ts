import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createGame } from "../src/game/state-machine.js";
import { applyModerationBlock } from "../src/safety/moderation.js";
import { PgGameRepository } from "../src/db/repository.js";
import { confirmCase, dismissCase, logIp, purgeExpired, viewEvidence } from "../src/safety/child-safety/vault.js";
import { backfillLegacyFlags } from "../src/safety/child-safety/maintenance.js";
import { moderateParentMessage } from "../src/safety/moderation.js";
import { issueCampusIdentity, resolveCampusIdentity } from "../src/security/campus-identity.js";
import { verifyCampusPass } from "../src/security/campus-pass.js";
import { claimsFor, newCampusKeyPair, signPass } from "./helpers/campus-pass-fixture.js";
import { buildServer } from "../src/app.js";
import type { LLMClient } from "../src/llm/client.js";
import type { AddressInfo } from "node:net";
import { vi, afterEach } from "vitest";

const DAY = 24 * 60 * 60 * 1000;
process.env.CHILD_SAFETY_EVIDENCE_KEY ??= randomBytes(32).toString("base64");

// Needs DATABASE_URL pointing at a scratch Postgres; migrations are applied here.
describe.skipIf(!process.env.DATABASE_URL)("child-safety vault on Postgres", () => {
  let repo: PgGameRepository;
  let pool: typeof import("../src/db/pool.js").pool;

  beforeAll(async () => {
    ({ pool } = await import("../src/db/pool.js"));
    const { migrate } = await import("../src/db/migrate.js");
    await migrate();
    repo = new PgGameRepository(pool);
  });

  async function flagged() {
    const state = { ...createGame("Pg"), phase: "family_chat" as const };
    await repo.saveGame(state);
    await repo.savePlayer(state.id, "parent1", "P1", "tok", "@pg:matrix.example");
    await logIp(repo.childSafety, { ip: "198.51.100.20", gameRef: state.id, event: "game_create", slot: "parent1", userAgent: "PgUA" });
    const { caseId } = await applyModerationBlock({
      repo, games: new Map(), state, sender: "parent1", content: "PG TEST FIXTURE", reason: "openai_moderation:sexual/minors",
      ipAddress: "198.51.100.20", banIp: false,
      classifier: { categories: ["sexual/minors"], scores: { "sexual/minors": 0.9 }, model: "omni-moderation-test" },
    });
    expect(caseId).toBeTruthy();
    return { state, caseId: caseId! };
  }

  it("evidence survives deleteGameData (no cascade), and the read is logged", async () => {
    const { state, caseId } = await flagged();
    const { rows: before } = await pool.query(`SELECT content FROM moderation_flags WHERE game_id = $1`, [state.id]);
    expect(before[0].content).toBe(`[withheld: child-safety case ${caseId}]`);

    await repo.deleteGameData(state.id);
    expect((await pool.query(`SELECT 1 FROM games WHERE id = $1`, [state.id])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM moderation_flags WHERE game_id = $1`, [state.id])).rows).toHaveLength(0);

    const { evidence } = await viewEvidence(repo.childSafety, caseId, "pg-reviewer", "10.1.1.1");
    expect(evidence.content).toBe("PG TEST FIXTURE");
    expect(evidence.userAgent).toBe("PgUA");
    expect(evidence.identifiers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "matrix", value: "@pg:matrix.example", verified: false })]));
    const log = await repo.childSafety.listAccess(caseId);
    expect(log.map((l) => l.action)).toEqual(["create", "view"]);

    const { rows: raw } = await pool.query(`SELECT ciphertext FROM child_safety.evidence_cases WHERE id = $1`, [caseId]);
    expect(Buffer.from(raw[0].ciphertext, "base64").toString("utf8")).not.toContain("PG TEST FIXTURE");
  });

  it("dismissed cases purge after retention; confirmed cases do not; open cases do not", async () => {
    const t0 = Date.now();
    const a = await flagged();
    const b = await flagged();
    const c = await flagged();
    await dismissCase(repo.childSafety, a.caseId, "r", null, "false positive (fixture)", t0);
    await confirmCase(repo.childSafety, b.caseId, "r", null, async () => {}, t0);
    await purgeExpired(repo.childSafety, t0 + 91 * DAY);
    expect(await repo.childSafety.getCase(a.caseId)).toBeNull();
    expect((await repo.childSafety.getCase(b.caseId))?.locked).toBe(true);
    expect((await repo.childSafety.getCase(c.caseId))?.status).toBe("open");
    expect((await repo.childSafety.listAccess(a.caseId)).map((l) => l.action)).toContain("purge");
    expect(await repo.childSafety.isIdentifierBanned({ kind: "ip", value: "198.51.100.20" })).toBe(true);
  });

  it("the schema refuses a purgeable open case and an unlocked confirmed case", async () => {
    const { caseId } = await flagged();
    await expect(pool.query(`UPDATE child_safety.evidence_cases SET purge_after = now() WHERE id = $1`, [caseId])).rejects.toThrow();
    await expect(pool.query(`UPDATE child_safety.evidence_cases SET status = 'confirmed', locked = false WHERE id = $1`, [caseId])).rejects.toThrow();
  });

  it("PUBLIC has no access to the child_safety schema", async () => {
    const { rows } = await pool.query(`SELECT has_schema_privilege('public', 'child_safety', 'USAGE') AS ok`);
    expect(rows[0].ok).toBe(false);
  });

  it("backfills pre-vault flags once and withholds their content", async () => {
    const state = createGame("Legacy");
    await repo.saveGame(state);
    const flagId = randomUUID();
    await pool.query(
      `INSERT INTO moderation_flags (id, game_id, sender, content, reason, ip_address) VALUES ($1, $2, 'parent1', 'LEGACY FIXTURE', 'openai_moderation:sexual/minors', '198.51.100.30')`,
      [flagId, state.id],
    );
    expect(await backfillLegacyFlags(repo, pool)).toBeGreaterThanOrEqual(1);
    const caseId = await repo.childSafety.findByExternalRef(`moderation_flag:${flagId}`);
    expect(caseId).toBeTruthy();
    const { evidence } = await viewEvidence(repo.childSafety, caseId!, "r", null);
    expect(evidence.content).toBe("LEGACY FIXTURE");
    const { rows } = await pool.query(`SELECT content FROM moderation_flags WHERE id = $1`, [flagId]);
    expect(rows[0].content).toBe(`[withheld: child-safety case ${caseId}]`);
    expect(await backfillLegacyFlags(repo, pool)).toBe(0);
  });
  // ── Web cabinets: a verified campus identity feeds the vault ────────────────
  describe("campus identity", () => {
    const originalOpenAi = process.env.OPENAI_API_KEY;
    afterEach(() => {
      vi.restoreAllMocks();
      if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAi;
    });

    const uniqueSub = () => `@pg-campus-${randomBytes(4).toString("hex")}:themultiverse.school`;

    async function restServer() {
      const llm = {
        streamResponse: async () => { throw new Error("no LLM in this test"); },
        completeResponse: async () => { throw new Error("no LLM in this test"); },
        completeJson: async () => { throw new Error("no LLM in this test"); },
      } as unknown as LLMClient;
      process.env.DISABLE_PORTRAITS = "1";
      const built = buildServer({ llm, repo, enableEviction: false, allowedOrigin: "*", socketPath: "/socket.io" });
      await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
      const base = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
      return { base, close: () => built.close() };
    }

    it("an identity is stored hashed in Postgres, survives a new repository (restart), and expires", async () => {
      const sub = uniqueSub();
      const token = await issueCampusIdentity(repo, { sub, name: "PG Synthetic" });
      const { rows } = await pool.query(`SELECT token_hash, sub FROM campus_identities WHERE sub = $1`, [sub]);
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).not.toBe(token);
      const afterRestart = new PgGameRepository(pool);
      expect(await resolveCampusIdentity(afterRestart, token)).toEqual({ sub, name: "PG Synthetic" });
      expect(await resolveCampusIdentity(afterRestart, token, Date.now() + 13 * 60 * 60 * 1000)).toBeNull();
    });

    it("a spent pass jti is refused by a fresh verifier on the same database (restart / second process)", async () => {
      const keys = newCampusKeyPair();
      const c = claimsFor();
      const pass = signPass(c, keys.privateKeyB64);
      const o = { publicKeyB64: keys.publicKeyB64, audience: "raising-intelligences" };
      expect(await verifyCampusPass(pass, { ...o, jtiStore: repo })).not.toBeNull();
      const fresh = new PgGameRepository(pool);
      expect(await verifyCampusPass(pass, { ...o, jtiStore: fresh })).toBeNull();
      const { rows } = await pool.query(`SELECT exp_at FROM campus_pass_jti WHERE jti = $1`, [c.jti]);
      expect(new Date(rows[0].exp_at).getTime()).toBe(c.exp * 1000);
      // Concurrent spends of one jti: exactly one wins.
      const c2 = claimsFor();
      const results = await Promise.all([1, 2, 3].map(() => new PgGameRepository(pool).consumeCampusPassJti(c2.jti, c2.exp * 1000, Date.now())));
      expect(results.filter(Boolean)).toHaveLength(1);
      // Expired rows are pruned.
      await fresh.consumeCampusPassJti(claimsFor().jti, c.exp * 1000, c.exp * 1000 + 1);
      expect((await pool.query(`SELECT 1 FROM campus_pass_jti WHERE jti = $1`, [c.jti])).rows).toHaveLength(0);
    });

    it("legacy IP-log rows read back unverified", async () => {
      const state = createGame("PgLegacyIp");
      await repo.saveGame(state);
      await pool.query(`INSERT INTO child_safety.ip_log (ip, game_ref, event, slot, account_id) VALUES ('198.51.100.60', $1, 'socket_create', 'parent1', '@old:matrix.example')`, [state.id]);
      const [row] = await repo.childSafety.ipLogForGame(state.id, 0);
      expect(row).toMatchObject({ accountId: "@old:matrix.example", accountVerified: false });
    });

    it("campus game → flag → verified matrix id → confirm bans it → a new REST game with it is refused; a claimed userId stays unverified", async () => {
      const sub = uniqueSub();
      const srv = await restServer();
      try {
        const identity = await issueCampusIdentity(repo, { sub, name: "PG Synthetic" });
        const created = await fetch(`${srv.base}/api/game`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.61" },
          body: JSON.stringify({ childName: "PgCampus", campusIdentity: identity }),
        });
        expect(created.status).toBe(200);
        const { gameId, campus } = await created.json();
        expect(campus).toBe("verified");
        expect((await pool.query(`SELECT campus_sub FROM games WHERE id = $1`, [gameId])).rows[0].campus_sub).toBe(sub);
        // A claimed (unverified) Matrix id from a players row rides along, unverified.
        await repo.savePlayer(gameId, "parent1", "P1", "tok", "@pg-claimed:matrix.example");
        // Once a game has seat rows, only a seat's own campus id counts.
        expect(await repo.campusSubForSeat(gameId, "parent1")).toBeNull();
        await repo.savePlayer(gameId, "parent1", "P1", "tok", undefined, sub);
        expect(await repo.campusSubForSeat(gameId, "parent1")).toBe(sub);
        expect((await repo.loadPlayers(gameId))[0]).toMatchObject({ userId: "@pg-claimed:matrix.example", campusSub: sub });

        const state = { ...(await repo.loadGame(gameId))!, phase: "family_chat" as const };
        process.env.OPENAI_API_KEY = "sk-test";
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
          model: "omni-moderation-test",
          results: [{ flagged: true, categories: { "sexual/minors": true }, category_scores: { "sexual/minors": 0.95 } }],
        }), { status: 200 }));
        const r = await moderateParentMessage({ repo, games: new Map([[gameId, state]]), state, sender: "parent1", content: "PG CAMPUS TEST FIXTURE", ipAddress: "198.51.100.61" });
        vi.restoreAllMocks();
        expect(r.blocked).toBe(true);

        const { rows: cases } = await pool.query(`SELECT id FROM child_safety.evidence_cases WHERE game_ref = $1`, [gameId]);
        expect(cases).toHaveLength(1);
        const row = (await repo.childSafety.getCase(cases[0].id))!;
        expect(row.identifiers).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "campus", value: sub, verified: true, role: "flagged" }),
          expect.objectContaining({ kind: "matrix", value: "@pg-claimed:matrix.example", verified: false }),
        ]));

        const confirmed = await confirmCase(repo.childSafety, row.id, "pg-reviewer", null, (ip, why) => repo.banIp(ip, why));
        expect(confirmed.banned.map((b) => `${b.kind}:${b.value}`)).toContain(`campus:${sub}`);
        expect(await repo.childSafety.isIdentifierBanned({ kind: "campus", value: sub })).toBe(true);
        expect(await repo.childSafety.isIdentifierBanned({ kind: "matrix", value: "@pg-claimed:matrix.example" })).toBe(false);

        const again = await issueCampusIdentity(repo, { sub, name: "PG Synthetic" });
        const refused = await fetch(`${srv.base}/api/game`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.62" },
          body: JSON.stringify({ childName: "PgCampus", campusIdentity: again }),
        });
        expect(refused.status).toBe(403);
      } finally {
        await srv.close();
      }
    });
  });
});
