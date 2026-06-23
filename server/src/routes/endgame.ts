import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import { EndgameEngine } from "../game/endgame-engine.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { logger } from "../logger.js";

interface EndgameRouteLimiters {
  llmRateLimit?: RequestHandler;
}

/**
 * Endgame HTTP routes. The factory takes the shared in-memory games Map so it
 * reads and writes the same store the rest of the game routes use — the
 * integrator passes in the Map that backs createGameRoutes.
 */
export function createEndgameRoutes(
  engine: EndgameEngine,
  games: Map<string, GameState>,
  repo: GameRepository,
  limiters: EndgameRouteLimiters = {}
): Router {
  const { llmRateLimit } = limiters;
  const router = Router();

  const gameLocks = new Map<string, Promise<void>>();

  function withGameLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const prev = gameLocks.get(gameId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    gameLocks.set(gameId, next.then(() => {}, () => {}));
    return next;
  }

  router.post("/game/:id/epilogue", ...(llmRateLimit ? [llmRateLimit] : []), async (req: Request, res: Response) => {
    if (!games.get(req.params.id as string)) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    await withGameLock(req.params.id as string, async () => {
      const state = games.get(req.params.id as string);
      if (!state) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "Game not found" })}\n\n`);
        res.end();
        return;
      }
      try {
        const result = await engine.generateEpilogue(state, (chunk) => {
          res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
        });
        games.set(result.state.id, result.state);
        await repo.saveGame(result.state);
        res.write(
          `data: ${JSON.stringify({ type: "done", phase: result.state.phase, epilogue: result.epilogue })}\n\n`
        );
        res.end();
      } catch (err) {
        logger.error("epilogue_error", { gameId: req.params.id, error: String(err) });
        res.write(`data: ${JSON.stringify({ type: "error", error: "An internal error occurred" })}\n\n`);
        res.end();
      }
    });
  });

  router.post("/game/:id/adult-chat", async (req: Request, res: Response) => {
    const state = games.get(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const { scenario } = req.body as { scenario: string };
    if (!scenario) {
      res.status(400).json({ error: "scenario is required" });
      return;
    }
    try {
      const next = await engine.startAdultConversation(state, scenario);
      games.set(next.id, next);
      await repo.saveGame(next);
      res.json({ phase: next.phase, event: next.currentEvent });
    } catch (err) {
      logger.error("adult_chat_error", { gameId: req.params.id, error: String(err) });
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.post("/game/:id/report-card", ...(llmRateLimit ? [llmRateLimit] : []), async (req: Request, res: Response) => {
    if (!games.get(req.params.id as string)) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const { epilogue } = req.body as { epilogue?: string };

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    await withGameLock(req.params.id as string, async () => {
      const state = games.get(req.params.id as string);
      if (!state) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "Game not found" })}\n\n`);
        res.end();
        return;
      }
      try {
        const result = await engine.generateReportCard(state, epilogue ?? "", (chunk) => {
          res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
        });
        games.set(result.state.id, result.state);
        await repo.saveEndgame(result.state.id, epilogue ?? "", result.reportCard);
        await repo.saveGame(result.state);
        res.write(
          `data: ${JSON.stringify({ type: "done", phase: result.state.phase, reportCard: result.reportCard })}\n\n`
        );
        res.end();
      } catch (err) {
        logger.error("report_card_error", { gameId: req.params.id, error: String(err) });
        res.write(`data: ${JSON.stringify({ type: "error", error: "An internal error occurred" })}\n\n`);
        res.end();
      }
    });
  });

  return router;
}
