import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import { EndgameEngine } from "../game/endgame-engine.js";
import type { GameRepository } from "../db/repository.js";
import type { GameState } from "../types.js";
import { logger } from "../logger.js";
import { generateMomentIllustrations } from "../portrait-gen.js";
import { withGameLock } from "../lib/game-lock.js";
import { initSSE, sseChunk, sseDone, sseError } from "../lib/sse.js";
import { resolveGame } from "../lib/resolve-game.js";

interface EndgameRouteOptions {
  llmRateLimit?: RequestHandler;
  /** Shared lock map — pass the same instance used by game routes and socket
   * handlers so all operations on the same game are serialized. */
  gameLocks?: Map<string, Promise<void>>;
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
  options: EndgameRouteOptions = {}
): Router {
  const { llmRateLimit, gameLocks = new Map<string, Promise<void>>() } = options;
  const router = Router();

  const lock = <T>(gameId: string, fn: () => Promise<T>) => withGameLock(gameLocks, gameId, fn);
  const resolve = (id: string) => resolveGame(id, games, repo);

  router.post("/game/:id/epilogue", ...(llmRateLimit ? [llmRateLimit] : []), async (req: Request, res: Response) => {
    if (!(await resolve(req.params.id as string))) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    initSSE(res);

    try {
      await lock(req.params.id as string, async () => {
        const state = await resolve(req.params.id as string);
        if (!state) { sseError(res, "Game not found"); return; }
        try {
          const result = await engine.generateEpilogue(state, (chunk) => { sseChunk(res, chunk); });
          games.set(result.state.id, result.state);
          await repo.saveGame(result.state);
          sseDone(res, { phase: result.state.phase, epilogue: result.epilogue });
        } catch (err) {
          logger.error("epilogue_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
          sseError(res, "An internal error occurred");
        }
      });
    } catch (err) {
      logger.error("epilogue_lock_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
      sseError(res, "An internal error occurred");
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
      logger.error("adult_chat_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.post("/game/:id/report-card", ...(llmRateLimit ? [llmRateLimit] : []), async (req: Request, res: Response) => {
    if (!(await resolve(req.params.id as string))) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const { epilogue } = req.body as { epilogue?: string };

    initSSE(res);

    try {
      await lock(req.params.id as string, async () => {
        const state = await resolve(req.params.id as string);
        if (!state) { sseError(res, "Game not found"); return; }
        try {
          const result = await engine.generateReportCard(state, epilogue ?? "", (chunk) => {
            sseChunk(res, chunk);
          });
          games.set(result.state.id, result.state);
          await repo.saveEndgame(result.state.id, epilogue ?? "", result.reportCard);
          await repo.saveGame(result.state);
          sseDone(res, { phase: result.state.phase, reportCard: result.reportCard });

          // Fire-and-forget album generation
          const userId = req.query.userId as string | undefined;
          if (userId) {
            (async () => {
              try {
                let partnerDisplayName: string | undefined;
                const isSoloGame = state.relationshipType === "solo parent" || state.relationshipType === "solo";
                if (!isSoloGame) {
                  const players = await repo.loadPlayers(state.id);
                  const otherPlayer = players.find(p => p.slot === "parent2");
                  partnerDisplayName = otherPlayer?.displayName ?? undefined;
                }

                const albumData = await engine.generateAlbumData(
                  state, epilogue ?? "", result.reportCard, partnerDisplayName
                );

                const partnerType = isSoloGame ? "generated" : "real";
                const partnerId = await repo.saveAlbumPartner({
                  userId,
                  partnerName: albumData.partnerName,
                  partnerType,
                  relationshipSummary: albumData.relationshipSummary,
                });

                const illustrations = await generateMomentIllustrations(
                  state.id,
                  albumData.moments.map((m, i) => ({ visualPrompt: m.visualPrompt, sortOrder: i }))
                );

                const momentsWithImages = albumData.moments.map((m, i) => ({
                  age: m.age,
                  title: m.title,
                  description: m.description,
                  momentType: m.momentType,
                  imagePath: illustrations[i]?.imagePath ?? null,
                  sortOrder: i,
                }));

                await repo.saveAlbumMoments(state.id, momentsWithImages);
                await repo.linkGameToPartner(userId, state.id, partnerId);

                logger.info("album_generated", { gameId: state.id, userId, moments: momentsWithImages.length });
              } catch (e) {
                logger.error("album_generation_failed", { gameId: state.id, error: (e as Error).message });
              }
            })();
          }
        } catch (err) {
          logger.error("report_card_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
          sseError(res, "An internal error occurred");
        }
      });
    } catch (err) {
      logger.error("report_card_lock_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
      sseError(res, "An internal error occurred");
    }
  });

  return router;
}
