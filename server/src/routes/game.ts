import { Router } from "express";
import type { Request, Response } from "express";
import { existsSync } from "fs";
import path from "path";
import { ConversationEngine } from "../game/conversation-engine.js";
import { createGame } from "../game/state-machine.js";
import type { GameState, Sender } from "../types.js";
import type { GameRepository } from "../db/repository.js";
import { generateFirstPortrait, generateNextPortrait, PORTRAITS_DIR } from "../portrait-gen.js";
import { logger } from "../logger.js";

const VALID_SENDERS: Sender[] = ["parent1", "parent2"];
const MAX_CHILD_NAME_LENGTH = 50;
const MAX_MESSAGE_LENGTH = 2000;

export function createGameRoutes(
  engine: ConversationEngine,
  games: Map<string, GameState>,
  repo: GameRepository
): Router {
  const router = Router();

  // Per-game operation queue — serializes write operations so concurrent HTTP
  // requests on the same gameId can't read the same snapshot, run their LLM
  // calls in parallel, and then overwrite each other on write-back.
  const gameLocks = new Map<string, Promise<void>>();

  // Prefetched event promises — kicked off at game creation (event 1) and after
  // every end-chat (events 2+), so next-event returns instantly instead of waiting.
  const prefetchedEvents = new Map<string, Promise<import("../types.js").GameEvent>>();

  function withGameLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const prev = gameLocks.get(gameId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    gameLocks.set(gameId, next.then(() => {}, () => {}));
    return next;
  }

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
    if (childName.length > MAX_CHILD_NAME_LENGTH) {
      res.status(400).json({ error: `childName must be ${MAX_CHILD_NAME_LENGTH} characters or fewer` });
      return;
    }
    const state = createGame(childName, relationshipType);
    games.set(state.id, state);
    await repo.saveGame(state);
    res.json({ gameId: state.id });
    // Kick off portrait and first-event generation in parallel so the
    // GuardianScreen doesn't have to wait for either.
    generateFirstPortrait(state.id).catch(() => {});
    prefetchedEvents.set(state.id, engine.prefetchNextEvent(state));
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
    const gameId = req.params.id as string;

    const state = await resolveGame(gameId);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    const prefetched = prefetchedEvents.get(gameId);
    prefetchedEvents.delete(gameId);

    try {
      const next = prefetched
        ? engine.applyPrefetchedEvent(state, await prefetched)
        : await engine.startEvent(state);
      games.set(next.id, next);
      if (next.currentEvent) await repo.saveEvent(next.id, next.currentEvent);
      await repo.saveGame(next);
      res.json({ event: next.currentEvent, phase: next.phase });
    } catch (err) {
      logger.error("next_event_error", { gameId, error: String(err) });
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.post("/game/:id/message", async (req: Request, res: Response) => {
    const { sender, content } = req.body as { sender: Sender; content: string };

    if (!VALID_SENDERS.includes(sender)) {
      res.status(400).json({ error: "sender must be parent1 or parent2" });
      return;
    }
    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `content must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
      return;
    }

    // Pre-check so we can return a proper 404 before switching to SSE mode.
    const precheck = await resolveGame(req.params.id as string);
    if (!precheck) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    await withGameLock(req.params.id as string, async () => {
      // Re-read state inside the lock — another handler may have written a newer
      // snapshot while this request was queued.
      const state = await resolveGame(req.params.id as string);
      if (!state) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "Game not found" })}\n\n`);
        res.end();
        return;
      }
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
        logger.error("message_error", { gameId: req.params.id, error: String(err) });
        res.write(`data: ${JSON.stringify({ type: "error", error: "An internal error occurred" })}\n\n`);
        res.end();
      }
    });
  });

  router.post("/game/:id/end-chat", async (req: Request, res: Response) => {
    const precheck = await resolveGame(req.params.id as string);
    if (!precheck) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    await withGameLock(req.params.id as string, async () => {
      const state = await resolveGame(req.params.id as string);
      if (!state) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "Game not found" })}\n\n`);
        res.end();
        return;
      }
      try {
        // Kick off next-event prefetch immediately — runs in parallel with the
        // psychologist so the event is ready before the player finishes reading debrief.
        // Uses the current identity doc (one conversation behind) which is fine;
        // the world manager relies more on the events list than the identity snapshot.
        if (state.currentEventNumber < state.totalEvents) {
          prefetchedEvents.set(state.id, engine.prefetchNextEvent(state));
        }
        const next = await engine.endFamilyChat(state, () => {
          // Psychologist output is internal — not surfaced to the player.
        });
        games.set(next.id, next);
        const latestSnapshot = next.identitySnapshots[next.identitySnapshots.length - 1];
        if (latestSnapshot) await repo.saveSnapshot(next.id, latestSnapshot);
        await repo.saveGame(next);
        res.write(`data: ${JSON.stringify({ type: "done", phase: next.phase })}\n\n`);
        res.end();
      } catch (err) {
        logger.error("end_chat_error", { gameId: req.params.id, error: String(err) });
        res.write(`data: ${JSON.stringify({ type: "error", error: "An internal error occurred" })}\n\n`);
        res.end();
      }
    });
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

  // Kick off generation of the next portrait in the chain — called by the client
  // as soon as a conversation begins so the portrait is ready for the next event.
  router.post("/game/:id/portraits/next", async (req: Request, res: Response) => {
    const state = await resolveGame(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    res.json({ ok: true });
    generateNextPortrait(state.id).catch(() => {});
  });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Long-poll until the portrait file for this game+slug appears on disk.
  // The client calls this ONCE and waits — no retry loop, no polling.
  // Responds with { url } when ready, 408 if it takes longer than 5 minutes.
  router.get("/game/:id/portraits/:slug/await", async (req: Request, res: Response) => {
    const { id, slug } = req.params as { id: string; slug: string };
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid game ID" });
      return;
    }
    if (!/^age-\d+$/.test(slug)) {
      res.status(400).json({ error: "Invalid slug" });
      return;
    }
    const filePath = path.join(PORTRAITS_DIR, id, `${slug}.png`);
    const TIMEOUT_MS = 5 * 60 * 1000;
    const CHECK_INTERVAL_MS = 1000;
    const deadline = Date.now() + TIMEOUT_MS;

    let closed = false;
    res.on("close", () => { closed = true; });

    const check = () => {
      if (closed || res.writableEnded) return;
      if (existsSync(filePath)) {
        res.json({ url: `portraits/${id}/${slug}.png` });
        return;
      }
      if (Date.now() >= deadline) {
        res.status(408).json({ error: "Portrait not ready in time" });
        return;
      }
      setTimeout(check, CHECK_INTERVAL_MS);
    };

    check();
  });

  return router;
}
