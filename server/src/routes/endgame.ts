import { Router } from "express";
import type { Request, Response } from "express";
import { EndgameEngine } from "../game/endgame-engine.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";

/**
 * Endgame HTTP routes. The factory takes the shared in-memory games Map so it
 * reads and writes the same store the rest of the game routes use — the
 * integrator passes in the Map that backs createGameRoutes.
 */
export function createEndgameRoutes(
  engine: EndgameEngine,
  games: Map<string, GameState>,
  repo: GameRepository
): Router {
  const router = Router();

  router.post("/game/:id/epilogue", async (req: Request, res: Response) => {
    const state = games.get(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    try {
      const result = await engine.generateEpilogue(state);
      games.set(result.state.id, result.state);
      await repo.saveGame(result.state);
      res.json({ phase: result.state.phase, epilogue: result.epilogue });
    } catch (err) {
      console.error("[endgame] epilogue error:", err);
      res.status(500).json({ error: "An internal error occurred" });
    }
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
      console.error("[endgame] adult-chat error:", err);
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.post("/game/:id/report-card", async (req: Request, res: Response) => {
    const state = games.get(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const { epilogue } = req.body as { epilogue: string };
    try {
      const result = await engine.generateReportCard(state, epilogue ?? "");
      games.set(result.state.id, result.state);
      await repo.saveEndgame(result.state.id, epilogue ?? "", result.reportCard);
      await repo.saveGame(result.state);
      res.json({ phase: result.state.phase, reportCard: result.reportCard });
    } catch (err) {
      console.error("[endgame] report-card error:", err);
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  return router;
}
