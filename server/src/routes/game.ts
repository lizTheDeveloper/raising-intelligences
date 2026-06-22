import { Router } from "express";
import type { Request, Response } from "express";
import { ConversationEngine } from "../game/conversation-engine.js";
import { createGame } from "../game/state-machine.js";
import type { GameState, Sender } from "../types.js";

const games = new Map<string, GameState>();

export function createGameRoutes(engine: ConversationEngine): Router {
  const router = Router();

  router.post("/game", (req: Request, res: Response) => {
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
    res.json({ gameId: state.id });
  });

  router.get("/game/:id/state", (req: Request, res: Response) => {
    const state = games.get(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const { identityDocument, identitySnapshots, ...publicState } = state;
    res.json(publicState);
  });

  router.post("/game/:id/next-event", async (req: Request, res: Response) => {
    const state = games.get(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    try {
      const next = await engine.startEvent(state);
      games.set(next.id, next);
      res.json({ event: next.currentEvent, phase: next.phase });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/game/:id/message", async (req: Request, res: Response) => {
    const state = games.get(req.params.id as string);
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
    const state = games.get(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    try {
      const next = await engine.endFamilyChat(state);
      games.set(next.id, next);
      res.json({ phase: next.phase });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/game/:id/end-debrief", (req: Request, res: Response) => {
    const state = games.get(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const next = engine.endDebrief(state);
    games.set(next.id, next);
    res.json({ phase: next.phase });
  });

  return router;
}
