import type pg from "pg";
import type { GameRepository } from "../../db/repository.js";
import { logger } from "../../logger.js";
import { childSafetyConfig } from "./config.js";
import type { ChildSafetyStore, Identifier } from "./store.js";
import { sanitizeClaimedUserId } from "../../security/campus-identity.js";
import { preserveEvidence, purgeExpired, type ContextTurn } from "./vault.js";

/** The pointer moderation.ts leaves in a flag row once its content is in the vault. */
export const WITHHELD_POINTER_SQL = String.raw`^\[withheld: child-safety case [0-9a-f-]{36}\]$`;
const WITHHELD_POINTER = new RegExp(WITHHELD_POINTER_SQL);

export function withheldPointer(caseId: string): string {
  return `[withheld: child-safety case ${caseId}]`;
}

/** True once a flag row's content has been moved into the vault. */
export function isWithheld(content: string): boolean {
  return WITHHELD_POINTER.test(content);
}

/** A moderation_flags row as stored. */
export interface StoredModerationFlag {
  id: string;
  gameId: string;
  sender: string;
  content: string;
  reason: string;
  ipAddress: string | null;
  createdAt: number;
}

/**
 * Copies one moderation_flags row into the vault (idempotent on the flag id)
 * and returns the case id. Throws if the vault write fails: the caller must
 * then keep the row, not delete it.
 *
 * Context and account identifiers are read from the game, which must still
 * exist: they are exactly what a game deletion would otherwise take with it.
 * Matrix userIds are client-claimed (kept unverified, never banned). A seat's
 * verified campus id goes in as a participant only: the seat may have changed
 * hands since the flag, so a reviewer decides, with a reason, whether it was
 * the sender's.
 */
export async function preserveModerationFlag(
  repo: Pick<GameRepository, "childSafety" | "loadGame" | "loadPlayers">,
  flag: StoredModerationFlag,
  source: "ri_legacy_flag" | "ri_flag_on_delete",
): Promise<string> {
  const state = await repo.loadGame(flag.gameId);
  const context: ContextTurn[] = (state?.messages ?? []).slice(-childSafetyConfig().contextTurns).map((m) => ({
    speaker: m.sender, content: m.content, at: m.timestamp, label: `${m.chatType} / scene ${m.eventNumber}`,
  }));
  const identifiers: Identifier[] = [];
  for (const p of await repo.loadPlayers(flag.gameId)) {
    if (sanitizeClaimedUserId(p.userId)) {
      identifiers.push({
        kind: "matrix", value: p.userId as string, verified: false, slot: p.slot,
        role: p.slot === flag.sender ? "flagged" : "participant",
      });
    }
    if (p.campusSub) {
      identifiers.push({ kind: "campus", value: p.campusSub, verified: true, slot: p.slot, role: "participant" });
    }
  }
  const openai = flag.reason.startsWith("openai_moderation:");
  const { caseId } = await preserveEvidence(repo.childSafety, {
    source,
    content: flag.content,
    context,
    categories: openai
      ? flag.reason.slice("openai_moderation:".length).split(",")
      : [/sexual|romantic|groom|intimate|erotic/i.test(flag.reason) ? "scene_reader:sexualization" : "scene_reader:block"],
    model: openai ? "omni-moderation (flag row; exact version not recorded)" : "scene reader (flag row)",
    reason: flag.reason,
    gameRef: flag.gameId,
    ipAddress: flag.ipAddress,
    // A per-message flag's IP is the sender's own; a scene block's is
    // whichever request ended the scene, possibly the co-player's.
    requestIpIsSender: openai,
    sender: flag.sender,
    userAgent: null,
    identifiers,
    incidentAt: flag.createdAt,
    externalRef: `moderation_flag:${flag.id}`,
    extra: {
      sender: flag.sender,
      ...(source === "ri_legacy_flag" ? { backfilled: true } : { preservedOnGameDelete: true }),
      ...(state ? { phase: state.phase, eventNumber: state.currentEventNumber, childName: state.childName } : {}),
    },
  });
  return caseId;
}

/**
 * One-time (idempotent) copy of pre-vault child-sexual-content flags from
 * moderation_flags into the vault. Each copied flag's content is then
 * replaced by a pointer to its case.
 *
 * Selected: per-message OpenAI flags (all sexual/minors or sexual-to-a-child),
 * and scene-reader blocks whose reason names sexual content. The old
 * grooming-classifier flags (mostly reversed false positives) are not opened
 * as cases here; deleteGameData vaults them if their game is ever deleted.
 */
export async function backfillLegacyFlags(repo: GameRepository, db: Pick<pg.Pool, "query">): Promise<number> {
  const { rows } = await db.query<{
    id: string; game_id: string; sender: string; content: string; reason: string; ip_address: string | null; created_at: Date;
  }>(
    `SELECT id, game_id, sender, content, reason, ip_address, created_at FROM moderation_flags
      WHERE content !~ $1
        AND (reason LIKE 'openai_moderation:%' OR reason ~* '(sexual|romantic|erotic|intimate)')
      ORDER BY created_at`,
    [WITHHELD_POINTER_SQL],
  );
  let copied = 0;
  for (const f of rows) {
    try {
      const caseId = await preserveModerationFlag(repo, {
        id: f.id, gameId: f.game_id, sender: f.sender, content: f.content, reason: f.reason,
        ipAddress: f.ip_address, createdAt: new Date(f.created_at).getTime(),
      }, "ri_legacy_flag");
      await db.query(`UPDATE moderation_flags SET content = $1 WHERE id = $2`, [withheldPointer(caseId), f.id]);
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
