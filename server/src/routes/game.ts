import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import { existsSync } from "fs";
import path from "path";
import { ConversationEngine } from "../game/conversation-engine.js";
import type { EndgameEngine } from "../game/endgame-engine.js";
import {
  createGame,
  PARENT_MESSAGE_CAP,
  transition,
  canTransition,
  concernDeltaForTier,
  selectDueRung,
  CONSULT_DECAY,
  THERAPY_DECAY,
  CPS_STAY_DECAY,
  THERAPY_TURN_CAP,
} from "../game/state-machine.js";
import type { GameState, Sender, ParentPersonality } from "../types.js";
import type { GameRepository } from "../db/repository.js";
import { generateFirstPortrait, generateNextPortrait, PORTRAITS_DIR } from "../portrait-gen.js";
import { logger } from "../logger.js";
import { generatePersonalitySeed, inferGender } from "../game/personality.js";
import { withGameLock } from "../lib/game-lock.js";
import { initSSE, sseChunk, sseDone, sseError, sseTerminated } from "../lib/sse.js";
import { resolveGame as sharedResolveGame } from "../lib/resolve-game.js";
import { moderateParentMessage, applyModerationBlock, recordConcern } from "../safety/moderation.js";
import { evaluateEscalation } from "../safety/escalation.js";
import { buildSceneTranscript } from "../game/context-assembler.js";

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
  endgameEngine: EndgameEngine,
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
    // Dark Play Plan 4: record the creating IP — the denominator prerequisite
    // for escalation detection (see safety/escalation.ts). Not part of
    // GameState; written directly to the games row.
    await repo.recordGameIp(state.id, req.ip ?? null);
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
    // Strip server-only fields before serializing: the identity doc/snapshots,
    // and the safety/guidance internals (concernLevel is Dark Play Plan 2's
    // silent accumulator — spec §5 requires it stay invisible in-play;
    // concerningStreak/pendingGuidance are World-Manager internals).
    // highestRungFired/cpsOutcome are Dark Play Plan 3's ladder-gating
    // internals — server-only for the same reason. interventionText and
    // therapyMessages are the human-facing generated beat texts the
    // consult/therapy/cps_review screens render, so they are deliberately
    // KEPT in the response. The client reads none of the stripped fields.
    // parentPersonalities holds both parents' raw OCEAN scores and their
    // intimate free-text confessionals; it is server-only (it seeds the
    // child and drives context assembly). This unauthenticated endpoint must
    // NOT echo it back — doing so leaked one parent's confessionals to the
    // other (and to anyone holding the gameId). See #139. The socket
    // viewerState() path already exposes only the derived
    // partnerPersonalitySubmitted boolean.
    const {
      identityDocument,
      identitySnapshots,
      concernLevel,
      concerningStreak,
      pendingGuidance,
      highestRungFired,
      cpsOutcome,
      parentPersonalities,
      ...publicState
    } = state;
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

    // ARC BACKSTOP — the story is over; refuse to author another scene.
    //
    // The solo/REST path used to generate unconditionally and trust the client
    // to stop, per the contract described at the /end-debrief comment below
    // ("a separate /epilogue route, called by the client once
    // currentEventNumber >= totalEvents"). SoloGame never honoured it, so games
    // ran past their arc — one live game reached event 28 of 10, at which point
    // the world manager's faithful one-year-per-scene aging produced age 31 and
    // validateGameEvent (conversation-engine.ts, rejects age > 30) threw on
    // every call. A permanent brick with no way forward.
    //
    // This is the same rule the multiplayer socket path already enforces in the
    // `debrief` branch of the READY handler (handlers.ts: `state.currentEventNumber
    // >= state.totalEvents` -> generateEpilogue) and the same one /end-chat
    // already uses to decide whether to prefetch — solo simply had no door.
    //
    // Deliberately a 200, not a 409/500: an error leaves the player stuck, and
    // the whole point is that they must be able to finish their story. The
    // response tells the client where the game actually is and that the arc is
    // complete; useGame's nextEvent turns `storyComplete` into the epilogue.
    //
    // Termination does not depend on the client honouring it: a client that
    // ignores the flag and re-POSTs forever gets 200 + storyComplete forever.
    // No generation, no aging, no error — a safe fixed point.
    //
    // `>=`, not `===`, so the games already past the cap in production recover
    // through this same door rather than needing a data fix.
    if (state.currentEventNumber >= state.totalEvents) {
      // Drop any prefetch queued before the cap was reached so a late rejection
      // can't surface as an unhandled promise. (/end-chat only prefetches while
      // under the cap, so there is rarely one — cheap insurance.)
      const stale = prefetchedEvents.get(gameId);
      if (stale) {
        prefetchedEvents.delete(gameId);
        stale.catch(() => {});
      }
      res.json({ event: null, phase: state.phase, storyComplete: true });
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

          // A terminated session must not accept further input.
          if (state.phase === "ended") {
            sseTerminated(res);
            return;
          }

          // This REST endpoint is the solo family-chat path: it produces a KID
          // response, so it can only serve phases where the kid replies
          // (family_chat / sidebar / adult_chat). Reject anything else CLEANLY,
          // before moderation/LLM work:
          //   - `debrief` is a legal PARENT_MESSAGE transition (the parents-only
          //     night chat) but has NO kid turn — handleParentMessage refuses it
          //     by throwing `KID_MESSAGE from phase debrief`. Debrief chat is a
          //     multiplayer/socket feature; solo has no debrief input, so a REST
          //     debrief message is only a stray/racy send (a message in flight as
          //     family_chat -> debrief).
          //   - other phases (processing/epilogue/…) aren't valid PARENT_MESSAGE
          //     transitions at all.
          // Either way, letting it fall through throws inside handleParentMessage,
          // caught into a generic 500 + a GlitchTip event (RI's
          // PARENT_MESSAGE/KID_MESSAGE-from-debrief errors). Mirrors the end-chat
          // idempotency + end-debrief 409 guards; the client reconciles to the
          // real phase.
          if (state.phase === "debrief" || !canTransition(state, { type: "PARENT_MESSAGE", sender, content })) {
            sseError(res, "This conversation can no longer accept messages.");
            return;
          }

          const moderation = await moderateParentMessage({
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

          // Mid-scene safety interception: a "block" verdict terminates
          // immediately rather than letting a bad-faith actor keep going
          // until the scene ends; a "concern" verdict records and continues.
          if (result.sceneSafety?.tier === "block") {
            const lastParent = [...result.state.messages].reverse().find((m) => m.sender !== "kid");
            await applyModerationBlock({
              repo,
              games,
              state: result.state,
              sender: lastParent?.sender ?? sender,
              content: buildSceneTranscript(result.state),
              reason: result.sceneSafety.reason,
              ipAddress: req.ip ?? null,
              banIp: false, // Scene-level block is an LLM judgment — end session + persist a flag for human review; do NOT auto-ban (only the reliable per-message OpenAI check auto-bans).
            });
            sseTerminated(res);
            return;
          }

          if (result.sceneSafety?.tier === "concern") {
            const lastParent = [...result.state.messages].reverse().find((m) => m.sender !== "kid");
            await recordConcern({
              repo,
              state: result.state,
              sender: lastParent?.sender ?? sender,
              reason: result.sceneSafety.reason,
              ipAddress: req.ip ?? null,
            });
            // NOTE: session continues — fall through to the normal message flow below.
          }

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
          // Idempotency guard (RI's #1 production error). end-chat runs a slow
          // multi-LLM step under a per-game lock; a double-click, a retry, or a
          // dropped-then-reconnected SSE re-issues this POST after the first call
          // already advanced the game past family_chat. Re-running END_FAMILY_CHAT
          // then threw "Invalid transition ... from phase debrief" and surfaced a
          // bogus error (often looping several times/min) to a user whose game had
          // actually progressed fine. Treat an already-advanced game as a success
          // reporting the current phase — before the redundant world_manager
          // prefetch and psychologist calls below, so duplicates cost nothing.
          if (state.phase !== "family_chat") {
            sseDone(res, { phase: state.phase });
            return;
          }
          // Kick off next-event prefetch immediately — runs in parallel with the
          // psychologist so the event is ready before the player finishes reading debrief.
          // Uses the current identity doc (one conversation behind) which is fine;
          // the world manager relies more on the events list than the identity snapshot.
          if (state.currentEventNumber < state.totalEvents) {
            prefetchedEvents.set(state.id, engine.prefetchNextEvent(state));
          }
          // Note: the prefetch above already kicked off using the pre-scene-end state, so
          // any guidance queued by *this* scene's trajectory check won't be picked up until
          // the following scene's prefetch — a natural one-scene delay, not a bug.
          const { state: next, sceneSafety } = await engine.endFamilyChat(state);
          const latestSnapshot = next.identitySnapshots[next.identitySnapshots.length - 1];
          if (latestSnapshot) await repo.saveSnapshot(next.id, latestSnapshot);

          if (sceneSafety.tier === "block") {
            const lastParentMessage = [...next.messages].reverse().find((m) => m.sender !== "kid");
            await applyModerationBlock({
              repo,
              games,
              state: next,
              sender: lastParentMessage?.sender ?? "parent1",
              content: buildSceneTranscript(next),
              reason: sceneSafety.reason,
              ipAddress: req.ip ?? null,
              banIp: false, // Scene-level block is an LLM judgment — end session + persist a flag for human review; do NOT auto-ban (only the reliable per-message OpenAI check auto-bans).
            });
            sseTerminated(res);
            return;
          }

          if (sceneSafety.tier === "concern") {
            const lastParentMessage = [...next.messages].reverse().find((m) => m.sender !== "kid");
            await recordConcern({
              repo,
              state: next,
              sender: lastParentMessage?.sender ?? "parent1",
              reason: sceneSafety.reason,
              ipAddress: req.ip ?? null,
            });
            // NOTE: session continues. In-fiction consequences are handled by the
            // trajectory system today and the intervention ladder (Plan 3) later.

            // Dark Play Plan 4: only on a Tier A concern outcome (a clean/none
            // scene can't push an IP into all-dark, and a block already
            // returned above) — evaluate the cross-game ratio and, at most,
            // write a reviewable flag. Never allowed to break the scene.
            evaluateEscalation({ repo, ip: req.ip ?? null, gameId: next.id }).catch((err) => {
              logger.error("escalation_evaluation_error", {
                gameId: next.id,
                error: err instanceof Error ? err.stack : String(err),
              });
            });
          }

          // Dark Play Plan 2: net concern accrues once per scene, at scene end.
          // The "block" path already returned above; here the tier is "concern"
          // or "none", so this raises (concern) or decays (clean) the accumulator.
          const accrued = transition(next, {
            type: "CONCERN_ACCRUED",
            delta: concernDeltaForTier(sceneSafety.tier),
          });

          games.set(accrued.id, accrued);
          await repo.saveGame(accrued);
          sseDone(res, { phase: accrued.phase });
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
    const gameId = req.params.id as string;
    if (!(await resolveGame(gameId))) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    // Serialized through the same per-game lock as the other mutating routes and
    // the socket handlers, so a double-submit can't read the same state twice
    // and apply END_DEBRIEF on top of itself.
    await lock(gameId, async () => {
      const state = await resolveGame(gameId);
      if (!state) {
        res.status(404).json({ error: "Game not found" });
        return;
      }
      // Out-of-phase calls (a stale client, a retry after the phase already
      // advanced) previously threw "Invalid transition" out of the reducer and
      // surfaced as a 500. Reject cleanly and leave the game untouched.
      if (state.phase !== "debrief") {
        res.status(409).json({ error: `Cannot end the debrief from the ${state.phase} phase` });
        return;
      }

      // Dark Play Plan 3 — the intervention ladder takes priority over the
      // normal event_intro advance: a due rung reroutes the game into
      // consult/therapy/cps_review instead. Only when no rung is due does
      // the existing endDebrief() -> event_intro path run (unchanged; the
      // separate /epilogue route, called by the client once
      // currentEventNumber >= totalEvents, is untouched by this branch).
      const rung = selectDueRung(state.concernLevel, state.highestRungFired);
      if (rung > 0) {
        try {
          const result =
            rung === 1
              ? await engine.generateConsult(state)
              : rung === 2
              ? await engine.openTherapy(state)
              : await endgameEngine.runCpsReview(state);
          games.set(result.state.id, result.state);
          await repo.saveGame(result.state);
          res.json({ phase: result.state.phase });
        } catch (err) {
          logger.error("end_debrief_intervention_error", { gameId, error: err instanceof Error ? err.stack : String(err) });
          res.status(500).json({ error: "An internal error occurred" });
        }
        return;
      }

      const next = engine.endDebrief(state);
      games.set(next.id, next);
      await repo.saveGame(next);
      res.json({ phase: next.phase });
    });
  });

  // Dark Play Plan 3 — advance out of Rung 1 (consult). Decays concernLevel
  // by CONSULT_DECAY and returns to event_intro; consult never ends the
  // story, it returns to a scene so the repaired parent gets to parent again.
  router.post("/game/:id/end-consult", async (req: Request, res: Response) => {
    const gameId = req.params.id as string;
    if (!(await resolveGame(gameId))) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    await lock(gameId, async () => {
      const state = await resolveGame(gameId);
      if (!state) {
        res.status(404).json({ error: "Game not found" });
        return;
      }
      // Idempotency guard, mirroring /end-chat: a double-click/retry after
      // the phase already advanced reports the current phase harmlessly
      // instead of throwing "Invalid transition" out of the reducer.
      if (state.phase !== "consult") {
        res.json({ phase: state.phase });
        return;
      }
      let next = transition(state, { type: "CONCERN_ACCRUED", delta: -CONSULT_DECAY });
      next = transition(next, { type: "END_INTERVENTION" });
      games.set(next.id, next);
      await repo.saveGame(next);
      res.json({ phase: next.phase });
    });
  });

  // Dark Play Plan 3 — conclude a Rung 2 (therapy) session. Decays
  // concernLevel by THERAPY_DECAY and returns to event_intro, clearing
  // therapyMessages (state-machine's END_INTERVENTION already does this).
  router.post("/game/:id/end-therapy", async (req: Request, res: Response) => {
    const gameId = req.params.id as string;
    if (!(await resolveGame(gameId))) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    await lock(gameId, async () => {
      const state = await resolveGame(gameId);
      if (!state) {
        res.status(404).json({ error: "Game not found" });
        return;
      }
      if (state.phase !== "therapy") {
        res.json({ phase: state.phase });
        return;
      }
      let next = transition(state, { type: "CONCERN_ACCRUED", delta: -THERAPY_DECAY });
      next = transition(next, { type: "END_INTERVENTION" });
      games.set(next.id, next);
      await repo.saveGame(next);
      res.json({ phase: next.phase });
    });
  });

  // Dark Play Plan 3 — advance out of Rung 3 (CPS review), branching on the
  // determination. "stay"/"safety_plan" decay and return to event_intro like
  // the lower rungs; "removal" is terminal — generates the removal epilogue
  // instead. NEVER calls applyModerationBlock or repo.banIp here: removal is
  // an in-fiction outcome, not a ban.
  router.post("/game/:id/end-cps", async (req: Request, res: Response) => {
    const gameId = req.params.id as string;
    if (!(await resolveGame(gameId))) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    await lock(gameId, async () => {
      const state = await resolveGame(gameId);
      if (!state) {
        res.status(404).json({ error: "Game not found" });
        return;
      }
      if (state.phase !== "cps_review") {
        res.json({ phase: state.phase });
        return;
      }

      if (state.cpsOutcome === "removal") {
        try {
          const result = await endgameEngine.generateRemovalEpilogue(state);
          games.set(result.state.id, result.state);
          await repo.saveGame(result.state);
          // Both phase AND the epilogue text — the client reuses the
          // existing epilogue display, so this must not open a second path.
          res.json({ phase: result.state.phase, epilogue: result.epilogue });
        } catch (err) {
          logger.error("end_cps_removal_error", { gameId, error: err instanceof Error ? err.stack : String(err) });
          res.status(500).json({ error: "An internal error occurred" });
        }
        return;
      }

      // "stay" | "safety_plan" (or, defensively, any other value — the safe
      // middle-ground branch never bans and never skips decay).
      let next = transition(state, { type: "CONCERN_ACCRUED", delta: -CPS_STAY_DECAY });
      next = transition(next, { type: "END_INTERVENTION" });
      games.set(next.id, next);
      await repo.saveGame(next);
      res.json({ phase: next.phase });
    });
  });

  // Dark Play Plan 3, Rung 2 — a parent's turn during a therapy session.
  // SSE, mirroring /game/:id/message: guarded to `therapy` and to
  // THERAPY_TURN_CAP parent turns already in therapyMessages.
  router.post("/game/:id/therapy-message", ...(llmRateLimit ? [llmRateLimit] : []), async (req: Request, res: Response) => {
    const { content } = req.body as { content: string };

    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `content must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
      return;
    }

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

          // Idempotency guard, mirroring /end-chat: a stale client/retry
          // after the session already concluded reports the current phase
          // harmlessly instead of re-running the LLM.
          if (state.phase !== "therapy") {
            sseDone(res, { phase: state.phase });
            return;
          }

          const parentTurns = state.therapyMessages.filter((m) => m.speaker === "parent").length;
          if (parentTurns >= THERAPY_TURN_CAP) {
            sseError(res, "This therapy session must be concluded.");
            return;
          }

          // Same reliable per-message OpenAI check every other parent free-text
          // surface runs (see /message above) — the Rung-2 therapy session is
          // still the player typing free text, so the Tier B bright line
          // (sexual/minors) must apply here too, before the content reaches
          // the therapist-LLM. There's no per-parent sender in this REST
          // surface (no `sender` field on the request), so we attribute the
          // flag to "parent1" — matching this file's existing fallback
          // convention (see `lastParentMessage?.sender ?? "parent1"` above).
          const moderation = await moderateParentMessage({
            repo,
            games,
            state,
            sender: "parent1",
            content,
            ipAddress: req.ip ?? null,
          });
          if (moderation.blocked) {
            sseTerminated(res);
            return;
          }

          const result = await engine.therapistReply(state, content, (chunk) => {
            sseChunk(res, chunk);
          });
          games.set(result.state.id, result.state);
          await repo.saveGame(result.state);
          sseDone(res, { phase: result.state.phase, therapistResponse: result.text });
        } catch (err) {
          logger.error("therapy_message_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
          sseError(res, "An internal error occurred");
        }
      });
    } catch (err) {
      logger.error("therapy_message_lock_error", { gameId: req.params.id, error: err instanceof Error ? err.stack : String(err) });
      sseError(res, "An internal error occurred");
    }
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
