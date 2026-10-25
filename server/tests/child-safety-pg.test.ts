import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createGame } from "../src/game/state-machine.js";
import { applyModerationBlock } from "../src/safety/moderation.js";
import { PgGameRepository } from "../src/db/repository.js";
import { confirmCase, dismissCase, logIp, purgeExpired, viewEvidence } from "../src/safety/child-safety/vault.js";
import { backfillLegacyFlags } from "../src/safety/child-safety/maintenance.js";

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
});
