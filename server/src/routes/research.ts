import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { resolveGame } from "../lib/resolve-game.js";
import { isResearchEnabled } from "../research/config.js";
import { withGameLock } from "../lib/game-lock.js";
import { loadParentContext } from "../research/parent-context.js";
import { cleanUntrustedText } from "../research/sanitize.js";
import { requireGameSecret } from "../security/game-secret.js";
import {
  QUESTION_BANK,
  WAIT_KINDS,
  selectQuestions,
  type Question,
  type StoredAnswer,
  type WaitKind,
} from "../research/questions.js";

const MAX_QUESTIONS_PER_WAIT = 2;
function notAvailable(res: Response): void {
  res.status(404).json({ error: "Not available" });
}

type Validated =
  | { ok: true; question: Question; sceneIndex: number; answer: unknown; skipped: boolean; shownAt: number }
  | { ok: false; error: string };

function validateBody(body: unknown, state: GameState): Validated {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const question = QUESTION_BANK.find((q) => q.id === b.questionId && q.version === b.version);
  if (!question) return { ok: false, error: "Unknown question" };
  const { sceneIndex } = b;
  if (typeof sceneIndex !== "number" || !Number.isInteger(sceneIndex) || sceneIndex < 0) {
    return { ok: false, error: "Invalid sceneIndex" };
  }
  if (sceneIndex > state.currentEventNumber) return { ok: false, error: "sceneIndex is in the future" };
  if (typeof b.shownAt !== "number" || !Number.isSafeInteger(b.shownAt) || b.shownAt < 0) {
    return { ok: false, error: "Invalid shownAt" };
  }
  if (b.skipped !== undefined && typeof b.skipped !== "boolean") {
    return { ok: false, error: "Invalid skipped" };
  }
  if (b.skipped === true) {
    return { ok: true, question, sceneIndex, answer: null, skipped: true, shownAt: b.shownAt };
  }
  const spec = question.answer;
  if (spec.type === "tap") {
    if (typeof b.answer !== "string" || !spec.options.some((o) => o.value === b.answer)) {
      return { ok: false, error: "Invalid answer" };
    }
    return { ok: true, question, sceneIndex, answer: b.answer, skipped: false, shownAt: b.shownAt };
  }
  if (typeof b.answer !== "string") return { ok: false, error: "Invalid answer" };
  const text = cleanUntrustedText(b.answer, spec.maxLength);
  if (!text) return { ok: false, error: "Invalid answer" };
  return { ok: true, question, sceneIndex, answer: text, skipped: false, shownAt: b.shownAt };
}

export function createResearchRoutes(
  games: Map<string, GameState>,
  repo: GameRepository,
  options: { gameLocks?: Map<string, Promise<void>>; hasSeat?: (gameId: string) => boolean } = {},
): Router {
  const { gameLocks = new Map<string, Promise<void>>(), hasSeat = () => false } = options;
  const router = Router();

  // Check order: secret first (403 regardless of anything else), then the
  // research flag, then the stored adult flag. Everything after the secret that
  // fails is the same opaque 404 so a forged request learns nothing.
  async function requireResearchAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isResearchEnabled() || (await repo.getIsAdult(req.params.id as string)) !== true) {
        notAvailable(res);
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  }
  const gate = [requireGameSecret(repo), requireResearchAccess];

  router.get("/game/:id/questions", ...gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const wait = req.query.wait;
      if (typeof wait !== "string" || !WAIT_KINDS.includes(wait as WaitKind)) {
        res.status(400).json({ error: "Invalid wait" });
        return;
      }
      const gameId = req.params.id as string;
      const state = await resolveGame(gameId, games, repo);
      if (!state) {
        notAvailable(res);
        return;
      }
      let sceneIndex = state.currentEventNumber;
      if (req.query.sceneIndex !== undefined) {
        const raw = req.query.sceneIndex;
        const n = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(n) || n > state.currentEventNumber) {
          res.status(400).json({ error: "Invalid sceneIndex" });
          return;
        }
        sceneIndex = n;
      }
      const answers = await repo.listAnswers(gameId);
      // Skipped questions count as answered: never re-ask. about_you and scale
      // questions are asked once per game; about_moment questions repeat each
      // scene, so only a row for THIS scene excludes them.
      const kindById = new Map(QUESTION_BANK.map((q) => [q.id, q.kind]));
      const answeredIds = new Set(
        answers
          .filter((a) => kindById.get(a.questionId) !== "about_moment" || a.sceneIndex === sceneIndex)
          .map((a) => a.questionId),
      );
      const questions = selectQuestions({ wait: wait as WaitKind, answeredIds, limit: MAX_QUESTIONS_PER_WAIT });
      res.json({ questions });
    } catch (err) {
      next(err);
    }
  });

  router.post("/game/:id/answers", ...gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gameId = req.params.id as string;
      const state = await resolveGame(gameId, games, repo);
      if (!state) {
        notAvailable(res);
        return;
      }
      const v = validateBody(req.body, state);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      const stored: StoredAnswer = {
        gameId,
        sceneIndex: v.sceneIndex,
        questionId: v.question.id,
        questionVersion: v.question.version,
        kind: v.question.kind,
        answer: v.answer,
        skipped: v.skipped,
        shownAt: v.shownAt,
        answeredAt: Date.now(),
      };
      if (v.question.kind !== "about_you") {
        // The repository enforces "a skip never overwrites an answer".
        await repo.saveAnswer(stored);
      } else {
        // An about_you row changes the parent context, so save, rebuild and
        // publish under the per-game lock, serialized with the other handlers
        // that write game state. Publishing mutates the live state object in
        // place: a scene generation already in flight reduces from that same
        // object after its LLM call returns, so it neither loses this update
        // nor overwrites it with a stale copy.
        await withGameLock(gameLocks, gameId, async () => {
          await repo.saveAnswer(stored);
          const context = await loadParentContext(gameId, repo);
          const live = games.get(gameId);
          // Fail closed. JOIN_GAME seats a player in memory synchronously and
          // clears the context in the same tick, so this synchronous check (no
          // await between it and the assignment) cannot interleave with a seat:
          // either the seat is already visible here, or JOIN's clear runs after.
          if (live) live.parentContext = !hasSeat(gameId) && context ? context : undefined;
        });
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
