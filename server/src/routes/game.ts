import { Router } from "express";
import type { Request, Response } from "express";
import { ConversationEngine } from "../game/conversation-engine.js";
import { createGame } from "../game/state-machine.js";
import type { GameState, Sender } from "../types.js";
import type { GameRepository } from "../db/repository.js";

export function createGameRoutes(
  engine: ConversationEngine,
  games: Map<string, GameState>,
  repo: GameRepository
): Router {
  const router = Router();

  // Resolve a game from the in-memory store, falling back to the repository
  // (reconstructing from the latest persisted checkpoint) for reconnects.
  async function resolveGame(id: string): Promise<GameState | null> {
    const inMemory = games.get(id);
    if (inMemory) return inMemory;
    const loaded = await repo.loadGame(id);
    if (loaded) games.set(id, loaded);
    return loaded;
  }

  router.post("/game", async (req: Request, res: Response) => {
    const { childName, relationshipType } = req.body as {
      childName: string;
      relationshipType?: string;
    };
    if (!childName) {
      res.status(400).json({ error: "childName is required" });
      return;
    }
    const state = createGame(childName, relationshipType);
    games.set(state.id, state);
    await repo.saveGame(state);
    res.json({ gameId: state.id });
  });

  router.get("/game/:id/state", async (req: Request, res: Response) => {
    const state = await resolveGame(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const { identityDocument, identitySnapshots, ...publicState } = state;
    res.json(publicState);
  });

  router.post("/game/:id/next-event", async (req: Request, res: Response) => {
    const state = await resolveGame(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    try {
      const next = await engine.startEvent(state);
      games.set(next.id, next);
      if (next.currentEvent) await repo.saveEvent(next.id, next.currentEvent);
      await repo.saveGame(next);
      res.json({ event: next.currentEvent, phase: next.phase });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/game/:id/message", async (req: Request, res: Response) => {
    const state = await resolveGame(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    const { sender, content } = req.body as { sender: Sender; content: string };

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const result = await engine.handleParentMessage(state, sender, content, (chunk) => {
        res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
      });
      games.set(result.state.id, result.state);
      // Persist just the two new tail messages (parent + kid), then the checkpoint.
      const tail = result.state.messages.slice(-2);
      for (const m of tail) await repo.saveMessage(result.state.id, m);
      await repo.saveGame(result.state);
      res.write(
        `data: ${JSON.stringify({
          type: "done",
          kidResponse: result.kidResponse,
          messagesRemaining: engine.getMessageCapRemaining(result.state),
        })}\n\n`
      );
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`);
      res.end();
    }
  });

  router.post("/game/:id/end-chat", async (req: Request, res: Response) => {
    const state = await resolveGame(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    try {
      const next = await engine.endFamilyChat(state);
      games.set(next.id, next);
      const latestSnapshot = next.identitySnapshots[next.identitySnapshots.length - 1];
      if (latestSnapshot) await repo.saveSnapshot(next.id, latestSnapshot);
      await repo.saveGame(next);
      res.json({ phase: next.phase });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/game/:id/end-debrief", async (req: Request, res: Response) => {
    const state = await resolveGame(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const next = engine.endDebrief(state);
    games.set(next.id, next);
    await repo.saveGame(next);
    res.json({ phase: next.phase });
  });

  return router;
}
