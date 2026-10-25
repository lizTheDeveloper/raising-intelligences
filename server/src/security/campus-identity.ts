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
/**
 * The vault identifier kind for a campus id verified from a launch pass.
 * Distinct from "matrix" (client-claimed, unverified) so the two can never
 * be confused or merged.
 */
export const CAMPUS_KIND = "campus";
/** Campus Matrix ids, any case. A client may never claim one (see sanitizeClaimedUserId). */
const CAMPUS_SUB_ANY_CASE_RE = /^@[a-z0-9._=\-/+]{1,255}:themultiverse\.school$/i;

/**
 * A client-claimed Matrix userId, or undefined if it looks like a campus id:
 * those enter only through a verified pass, never as a claim (a claim of
 * someone else's campus id must not even reach the evidence record).
 */
export function sanitizeClaimedUserId(userId: unknown): string | undefined {
  if (typeof userId !== "string") return undefined;
  const v = userId.trim();
  if (!v || CAMPUS_SUB_ANY_CASE_RE.test(v)) return undefined;
  return v;
}
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
  return repo.childSafety.isIdentifierBanned({ kind: CAMPUS_KIND, value: sub }).catch((err) => {
    logger.error("campus_ban_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  });
}

// ── Who is speaking (IP-log occupant) ──────────────────────────────────────

/** REST requests prove a campus identity by sending the identity token in this header. */
export const CAMPUS_IDENTITY_HEADER = "x-campus-identity";

/** The occupant of a socket seat: its reconnect token, hashed. A new token is a new occupant. */
export function seatOccupant(playerToken: string): string {
  return `seat:${createHash("sha256").update(playerToken).digest("hex").slice(0, 32)}`;
}

/** The occupant of a REST request that proved campus id `sub`. */
export function campusOccupant(sub: string): string {
  return `id:${createHash("sha256").update(sub).digest("hex").slice(0, 32)}`;
}

/** The occupant of any REST request that proved nothing. */
export const REST_OCCUPANT = "rest";

/** Who sent a parent message: the IP-log occupant, and the verified campus id when the sender proved one. */
export interface Speaker {
  occupant: string;
  campusSub?: string | null;
}

/**
 * The speaker of a REST request on a game. Verified only when the request
 * itself carries an identity token for the campus id that created this solo
 * game: the REST message routes take no other credential, so anyone with the
 * game id could otherwise speak "as" the creator. Never throws.
 */
export async function restSpeaker(repo: GameRepository, gameId: string, identityHeader: unknown): Promise<Speaker> {
  if (typeof identityHeader !== "string" || !identityHeader) return { occupant: REST_OCCUPANT };
  try {
    const [id, gameSub] = await Promise.all([resolveCampusIdentity(repo, identityHeader), repo.getGameCampusSub(gameId)]);
    if (id && gameSub && id.sub === gameSub) return { occupant: campusOccupant(id.sub), campusSub: id.sub };
  } catch (err) {
    logger.error("campus_speaker_lookup_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  return { occupant: REST_OCCUPANT };
}
