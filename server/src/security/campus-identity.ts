/**
 * Campus identities for web cabinets. A verified campus launch pass
 * (campus-pass.ts) is traded once for an opaque identity token, which the
 * client then sends as `campusIdentity` when it creates or joins a game. The
 * server keeps only the token's SHA-256, mapped to the campus Matrix id, for
 * 12 hours (Postgres, so a restart signs nobody out).
 *
 * A resolved identity is a VERIFIED identifier: it is stored on the game
 * (games.campus_sub / players.campus_sub), checked against the child-safety
 * ban list, and written to the IP log with account_verified = true, so a
 * confirmed case bans it. An unknown or expired token is ignored — play goes
 * on anonymously, with IP-based safety as before.
 */
import { createHash, randomBytes } from "node:crypto";
import type { GameRepository } from "../db/repository.js";
import { logger } from "../logger.js";

export const CAMPUS_IDENTITY_TTL_MS = 12 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface CampusIdentity { sub: string; name: string }

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mints and stores an identity token for a campus id verified from a pass. */
export async function issueCampusIdentity(repo: GameRepository, id: CampusIdentity, nowMs = Date.now()): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await repo.saveCampusIdentity(hashToken(token), { ...id, expiresAt: nowMs + CAMPUS_IDENTITY_TTL_MS }, nowMs);
  return token;
}

/** The campus id behind a token, or null for anything unknown, expired or malformed. */
export async function resolveCampusIdentity(repo: GameRepository, token: unknown, nowMs = Date.now()): Promise<CampusIdentity | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  return repo.loadCampusIdentity(hashToken(token), nowMs);
}

/**
 * For game create/join: what the optional `campusIdentity` resolved to.
 * `status` is undefined when none was sent, "unknown" when one was sent but
 * the server doesn't know it (the client then asks campus for a fresh pass).
 * Never throws: a lookup failure counts as unknown, so it never blocks play.
 */
export async function campusIdentityForRequest(
  repo: GameRepository,
  token: unknown,
  nowMs = Date.now(),
): Promise<{ sub: string | null; status?: "verified" | "unknown" }> {
  if (token === undefined || token === null || token === "") return { sub: null };
  try {
    const id = await resolveCampusIdentity(repo, token, nowMs);
    return id ? { sub: id.sub, status: "verified" } : { sub: null, status: "unknown" };
  } catch (err) {
    logger.error("campus_identity_lookup_failed", { error: err instanceof Error ? err.message : String(err) });
    return { sub: null, status: "unknown" };
  }
}

/** Whether a confirmed child-safety case banned this campus id. Fails open on a storage error, like the IP ban check. */
export async function isCampusSubBanned(repo: GameRepository, sub: string | null): Promise<boolean> {
  if (!sub) return false;
  return repo.childSafety.isIdentifierBanned({ kind: "matrix", value: sub }).catch((err) => {
    logger.error("campus_ban_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  });
}
