import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import { existsSync } from "fs";
import path from "path";
import { ConversationEngine } from "../game/conversation-engine.js";
import { createGame, PARENT_MESSAGE_CAP } from "../game/state-machine.js";
import type { GameState, Sender, ParentPersonality } from "../types.js";
import type { GameRepository } from "../db/repository.js";
import { generateFirstPortrait, generateNextPortrait, PORTRAITS_DIR } from "../portrait-gen.js";
import { logger } from "../logger.js";
import { generatePersonalitySeed, inferGender } from "../game/personality.js";
import { withGameLock } from "../lib/game-lock.js";
import { initSSE, sseChunk, sseDone, sseError, sseTerminated } from "../lib/sse.js";
import { resolveGame as sharedResolveGame } from "../lib/resolve-game.js";
import { moderateParentMessage } from "../safety/moderation.js";

const VALID_SENDERS: Sender[] = ["parent1", "parent2"];
const MAX_CHILD_NAME_LENGTH = 50;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_RELATIONSHIP_TYPE_LENGTH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GameRouteOptions {
  llmRateLimit?: RequestHandler;
  gameCreateLimit?: RequestHandler;
  /** Shared lock map — pass the same instance to endgame routes and socket
   * handlers so cross-module operations on the same game are serialized. */
  gameLocks?: Map<string, Promise<void>>;
}

export function createGameRoutes(
  engine: ConversationEngine,
  games: Map<string, GameState>,
  repo: GameRepository,
  options: GameRouteOptions = {}
): Router {
  const { llmRateLimit, gameCreateLimit, gameLocks = new Map<string, Promise<void>>() } = options;
  const router = Router();

  // Prefetched event promises — kicked off at game creation (event 1) and after
  // every end-chat (events 2+), so next-event returns instantly instead of waiting.
  const prefetchedEvents = new Map<string, Promise<import("../types.js").GameEvent>>();

  const lock = <T>(gameId: string, fn: () => Promise<T>) => withGameLock(gameLocks, gameId, fn);
  const resolveGame = (id: string) => sharedResolveGame(id, games, repo);

  router.post("/game", ...(gameCreateLimit ? [gameCreateLimit] : []), async (req: Request, res: Response) => {
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
    if (relationshipType && relationshipType.length > MAX_RELATIONSHIP_TYPE_LENGTH) {
      res.status(400).json({ error: `relationshipType must be ${MAX_RELATIONSHIP_TYPE_LENGTH} characters or fewer` });
      return;
    }
    const state = createGame(childName, relationshipType);
    games.set(state.id, state);
    await repo.saveGame(state);
    res.json({ gameId: state.id });
    // Kick off gender inference, portrait, and first-event generation in parallel.
    inferGender(engine.llm, childName).then(async (gender) => {
      // Re-read the live state: /next-event may have already transitioned to
      // family_chat by the time gender inference completes (especially on retry).
      // Spreading the stale `state` here would revert the phase to event_intro.
      const current = games.get(state.id) ?? state;
      const updated = { ...current, childGender: gender };
      games.set(state.id, updated);
      await repo.saveGame(updated);
      generateFirstPortrait(state.id, gender).catch(() => {});
    }).catch(() => {
      generateFirstPortrait(state.id).catch(() => {});
    });
    prefetchedEvents.set(state.id, engine.prefetchNextEvent(state));
  });

  router.get("/game/:id/state", async (req: Request, res: Response) => {
    const state = await resolveGame(req.params.id as string);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
    const { identityDocument, identitySnapshots, ...publicState } = state;
    res.json({
      ...publicState,
      messagesRemaining: PARENT_MESSAGE_CAP - state.parentMessageCount,
    });
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
      logger.error("next_event_error", { gameId, error: err instanceof Error ? err.stack : String(err) });
      res.status(500).json({ error: "An internal error occurred" });
    }
  });

  router.post("/game/:id/message", ...(llmRateLimit ? [llmRateLimit] : []), async (req: Request, res: Response) => {
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

    initSSE(res);

    try {
      await lock(req.params.id as string, async () => {
        try {
          // Re-read state inside the lock — another handler may have written a newer
          // snapshot while this request was queued.
          const state = await resolveGame(req.params.id as string);
          if (!state) { sseError(res, "Game not found"); return; }

          const moderation = await moderateParentMessage({
            llm: engine.llm,
            repo,
            games,
            state,
            sender,
            content,
            ipAddress: req.ip ?? null,
          });
          if (moderation.blocked) {
            sseTerminated(res);
            return;
          }

          const result = await engine.handleParentMessage(state, sender, content, (chunk) => {
            sseChunk(res, chunk);
          });
          games.set(result.state.id, result.state);
          // Persist just the two new tail messages (parent + kid), then the checkpoint.
          const tail = result.state.messages.slice(-2);
          for (const m of tail) await repo.saveMessage(result.state.id, m);
          await repo.saveGame(result.state);
          sseDone(res, {
            kidResponse: result.kidResponse,
            messagesRemaining: engine.getMessageCapRemaining(result.state),
          });
        } catch (err) {
          logger.error("message_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
          sseError(res, "An internal error occurred");
        }
      });
    } catch (err) {
      logger.error("message_lock_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
      sseError(res, "An internal error occurred");
    }
  });

  router.post("/game/:id/end-chat", ...(llmRateLimit ? [llmRateLimit] : []), async (req: Request, res: Response) => {
    const precheck = await resolveGame(req.params.id as string);
    if (!precheck) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    initSSE(res);

    try {
      await lock(req.params.id as string, async () => {
        try {
          const state = await resolveGame(req.params.id as string);
          if (!state) { sseError(res, "Game not found"); return; }
          // Kick off next-event prefetch immediately — runs in parallel with the
          // psychologist so the event is ready before the player finishes reading debrief.
          // Uses the current identity doc (one conversation behind) which is fine;
          // the world manager relies more on the events list than the identity snapshot.
          if (state.currentEventNumber < state.totalEvents) {
            prefetchedEvents.set(state.id, engine.prefetchNextEvent(state));
          }
          const next = await engine.endFamilyChat(state);
          games.set(next.id, next);
          const latestSnapshot = next.identitySnapshots[next.identitySnapshots.length - 1];
          if (latestSnapshot) await repo.saveSnapshot(next.id, latestSnapshot);
          await repo.saveGame(next);
          sseDone(res, { phase: next.phase });
        } catch (err) {
          logger.error("end_chat_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
          sseError(res, "An internal error occurred");
        }
      });
    } catch (err) {
      logger.error("end_chat_lock_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
      sseError(res, "An internal error occurred");
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

  // Submit a parent's personality (OCEAN scores + confessionals). When all
  // required parents have submitted, generates and stores the personality seed.
  router.post("/game/:id/personality", ...(llmRateLimit ? [llmRateLimit] : []), async (req: Request, res: Response) => {
    const gameId = req.params.id as string;
    const state = await resolveGame(gameId);
    if (!state) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    const { ocean, confessional1, confessional2, slot } = req.body as {
      ocean: unknown;
      confessional1?: string;
      confessional2?: string;
      slot?: string;
    };

    // Validate ocean: must be an array of 5 integers each 1-4
    if (
      !Array.isArray(ocean) ||
      ocean.length !== 5 ||
      !ocean.every((v) => Number.isInteger(v) && v >= 1 && v <= 4)
    ) {
      res.status(400).json({ error: "ocean must be an array of 5 integers each between 1 and 4" });
      return;
    }

    const MAX_CONFESSIONAL_LENGTH = 500;
    if (
      (confessional1 !== undefined && (typeof confessional1 !== "string" || confessional1.length > MAX_CONFESSIONAL_LENGTH)) ||
      (confessional2 !== undefined && (typeof confessional2 !== "string" || confessional2.length > MAX_CONFESSIONAL_LENGTH))
    ) {
      res.status(400).json({ error: "confessionals must be strings of at most 500 characters" });
      return;
    }

    const parentSlot: "parent1" | "parent2" =
      slot === "parent2" ? "parent2" : "parent1";

    const personality: ParentPersonality = {
      ocean: ocean as [number, number, number, number, number],
      confessional1: confessional1 ?? "",
      confessional2: confessional2 ?? "",
    };

    try {
      await lock(gameId, async () => {
        const current = await resolveGame(gameId);
        if (!current) {
          res.status(404).json({ error: "Game not found" });
          return;
        }

        const updatedState: GameState = {
          ...current,
          parentPersonalities: {
            ...current.parentPersonalities,
            [parentSlot]: personality,
          },
        };
        games.set(gameId, updatedState);

        // Determine if we have enough personalities to generate the seed.
        // Solo games need only parent1; multiplayer needs both.
        const isSolo =
          updatedState.relationshipType === "solo parent" ||
          updatedState.relationshipType === "solo";

        const parent1 = updatedState.parentPersonalities.parent1;
        const parent2 = updatedState.parentPersonalities.parent2;

        const allReady = isSolo ? !!parent1 : !!(parent1 && parent2);

        if (allReady && parent1) {
          let seed = "";
          try {
            seed = await generatePersonalitySeed(
              engine.llm,
              updatedState.childName,
              parent1,
              isSolo ? undefined : parent2
            );
          } catch (err) {
            logger.warn("personality_seed_failed", { gameId, error: String(err) });
          }
          // Re-read the live state: /next-event runs without the game lock and may
          // have written a newer snapshot (e.g. phase: family_chat) while the seed
          // LLM call was in-flight. Using the stale updatedState would overwrite
          // that transition and leave the server stuck in event_intro.
          const latestState = games.get(gameId) ?? updatedState;
          const withSeed: GameState = {
            ...latestState,
            // Keep the personalities we just stored even if next-event ran first.
            parentPersonalities: updatedState.parentPersonalities,
            personalitySeed: seed,
          };
          games.set(gameId, withSeed);
          await repo.saveGame(withSeed);
          res.json({ ready: true });
        } else {
          await repo.saveGame(updatedState);
          res.json({ ready: false });
        }
      });
    } catch {
      res.status(500).json({ error: "Failed to process personality submission" });
    }
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
    generateNextPortrait(state.id, state.childGender).catch(() => {});
  });

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
