import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { GameRepository } from "../db/repository.js";
import type { GameState, Sender } from "../types.js";
import { PARENT_MESSAGE_CAP } from "../game/state-machine.js";
import { GAME_SECRET_HEADER, verifyGameSecret } from "./game-secret.js";

/**
 * Who may read a game's content, and what each reader sees (privacy review F1).
 *
 * A game id is not a credential: both co-parents hold it (the invite link
 * carries it), it has sat in page URLs, and so in analytics. A read needs
 * one of the reader's own credentials:
 *   - `x-game-secret`: the solo player's per-game secret (the creating
 *     device holds it). Reads as the owner of a seatless game, or as parent1
 *     if the game has since gained seats.
 *   - `x-player-token`: a seat's token. Reads as that seat only.
 *   - `x-matrix-openid`: a Matrix OpenID token, for the owner on another
 *     device. Reads a seatless game as its owner only when that Matrix user's
 *     kid row was written with proof of access (the secret or a seat token).
 */

export const PLAYER_TOKEN_HEADER = "x-player-token";
export const MATRIX_OPENID_HEADER = "x-matrix-openid";

export type MatrixVerifier = (token: unknown) => Promise<string | null>;

export type GameReader = { kind: "owner" } | { kind: "seat"; slot: Sender };

export type SeatOf = (gameId: string, token: unknown) => Promise<{ seated: boolean; slot: string | null }>;

/**
 * Caches verified OpenID tokens for a few minutes so a page of reads costs
 * one round trip to Synapse, not one per request. Failures are not cached.
 */
export function cachedMatrixVerifier(verify: MatrixVerifier, ttlMs = 5 * 60 * 1000, max = 2000, now: () => number = Date.now): MatrixVerifier {
  const cache = new Map<string, { sub: string; until: number }>();
  return async (token: unknown) => {
    if (typeof token !== "string" || token.length === 0 || token.length > 512) return null;
    const hit = cache.get(token);
    if (hit && hit.until > now()) return hit.sub;
    if (hit) cache.delete(token);
    const sub = await verify(token);
    if (sub) {
      cache.set(token, { sub, until: now() + ttlMs });
      if (cache.size > max) cache.delete(cache.keys().next().value as string);
    }
    return sub;
  };
}

/** The verified Matrix id of this request, or null. */
export async function matrixUserOf(req: Request, verify: MatrixVerifier): Promise<string | null> {
  return verify(req.header(MATRIX_OPENID_HEADER));
}

/**
 * Gate for `/user/:userId/...`: the caller must be signed in as that user.
 * 401 with no or an invalid sign-in; 403 signed in as someone else.
 */
export function requireMatrixUser(verify: MatrixVerifier): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    matrixUserOf(req, verify)
      .then((sub) => {
        if (!sub) return void res.status(401).json({ error: "Sign in first." });
        if (sub !== String(req.params.userId)) return void res.status(403).json({ error: "Forbidden" });
        next();
      })
      .catch(next);
  };
}

/** Whose reader this request is for `state`, or null for nobody. */
export async function gameReaderOf(
  req: Request,
  state: GameState,
  deps: { repo: GameRepository; seatOf: SeatOf; verifyMatrix: MatrixVerifier },
): Promise<GameReader | null> {
  const gameId = state.id;
  const token = req.header(PLAYER_TOKEN_HEADER);
  const seat = await deps.seatOf(gameId, token);
  if (token && seat.slot && (seat.slot === "parent1" || seat.slot === "parent2")) {
    return { kind: "seat", slot: seat.slot };
  }
  const secret = req.header(GAME_SECRET_HEADER);
  if (secret && verifyGameSecret(secret, await deps.repo.getAccessSecretHash(gameId))) {
    // The creator of a game that has since gained seats is parent1, and sees what parent1 sees.
    return seat.seated ? { kind: "seat", slot: "parent1" } : { kind: "owner" };
  }
  if (!seat.seated && req.header(MATRIX_OPENID_HEADER)) {
    const sub = await matrixUserOf(req, deps.verifyMatrix);
    if (sub && (await deps.repo.isProvenUserGame(sub, gameId))) return { kind: "owner" };
  }
  return null;
}

/**
 * The state a reader may see. Server-only fields are never sent to anyone.
 * personalitySeed is built from both parents' confessionals and no client
 * reads it, so it is never sent either. A seat gets only the messages shown
 * to that seat, and not the memory summary (the socket view never had it).
 */
export function stateForReader(state: GameState, reader: GameReader): Record<string, unknown> {
  const {
    identityDocument: _identityDocument,
    identitySnapshots: _identitySnapshots,
    concernLevel: _concernLevel,
    concerningStreak: _concerningStreak,
    pendingGuidance: _pendingGuidance,
    highestRungFired: _highestRungFired,
    cpsOutcome: _cpsOutcome,
    parentPersonalities: _parentPersonalities,
    parentContext: _parentContext,
    repairNote: _repairNote,
    sceneRepairLine: _sceneRepairLine,
    personalitySeed: _personalitySeed,
    ...publicState
  } = state;
  const base = { ...publicState, messagesRemaining: PARENT_MESSAGE_CAP - state.parentMessageCount };
  if (reader.kind === "owner") return base;
  const { memorySummary: _memorySummary, ...seatState } = base;
  return { ...seatState, messages: state.messages.filter((m) => m.visibleTo.includes(reader.slot)) };
}
