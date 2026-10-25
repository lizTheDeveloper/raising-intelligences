import type pg from "pg";
import type { GameRepository } from "../../db/repository.js";
import { logger } from "../../logger.js";
import { childSafetyConfig } from "./config.js";
import type { ChildSafetyStore } from "./store.js";
import { preserveEvidence, purgeExpired, type ContextTurn } from "./vault.js";

/**
 * One-time (idempotent) copy of pre-vault child-sexual-content flags from
 * moderation_flags into the vault. Before this existed, those rows were the
 * only copy and they cascade-deleted with their game. Each copied flag's
 * content is then replaced by a pointer to its case.
 *
 * Selected: per-message OpenAI flags (all sexual/minors or sexual-to-a-child),
 * and scene-reader blocks whose reason names sexual content. The old
 * grooming-classifier flags (mostly reversed false positives) are left alone.
 */
export async function backfillLegacyFlags(repo: GameRepository, db: Pick<pg.Pool, "query">): Promise<number> {
  const { rows } = await db.query<{
    id: string; game_id: string; sender: string; content: string; reason: string; ip_address: string | null; created_at: Date;
  }>(
    `SELECT id, game_id, sender, content, reason, ip_address, created_at FROM moderation_flags
      WHERE content NOT LIKE '[withheld:%'
        AND (reason LIKE 'openai_moderation:%' OR reason ~* '(sexual|romantic|erotic|intimate)')
      ORDER BY created_at`,
  );
  let copied = 0;
  for (const f of rows) {
    try {
      const state = await repo.loadGame(f.game_id).catch(() => null);
      const context: ContextTurn[] = (state?.messages ?? []).slice(-childSafetyConfig().contextTurns).map((m) => ({
        speaker: m.sender, content: m.content, at: m.timestamp, label: `${m.chatType} / scene ${m.eventNumber}`,
      }));
      const openai = f.reason.startsWith("openai_moderation:");
      const { caseId } = await preserveEvidence(repo.childSafety, {
        source: "ri_legacy_flag",
        content: f.content,
        context,
        categories: openai ? f.reason.slice("openai_moderation:".length).split(",") : ["scene_reader:sexualization"],
        model: openai ? "omni-moderation-latest (legacy flag; exact version not recorded)" : "scene reader (legacy flag)",
        reason: f.reason,
        gameRef: f.game_id,
        ipAddress: f.ip_address,
        userAgent: null,
        incidentAt: new Date(f.created_at).getTime(),
        externalRef: `moderation_flag:${f.id}`,
        extra: { sender: f.sender, backfilled: true },
      });
      await db.query(`UPDATE moderation_flags SET content = $1 WHERE id = $2`, [`[withheld: child-safety case ${caseId}]`, f.id]);
      copied++;
    } catch (err) {
      logger.error("child_safety_backfill_failed", { flagId: f.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (copied) logger.warn("child_safety_backfill", { copied });
  return copied;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Runs the retention sweep now and every six hours. Returns a stop function. */
export function startPurgeSweep(store: ChildSafetyStore, intervalMs = SIX_HOURS): () => void {
  const run = () =>
    purgeExpired(store).catch((err) => {
      logger.error("child_safety_purge_failed", { error: err instanceof Error ? err.message : String(err) });
    });
  void run();
  const t = setInterval(run, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
