import type { Server, Socket } from "socket.io";
import type { GameState, GameEvent, Sender, ParentPersonality } from "../types.js";
import type { ConversationEngine } from "../game/conversation-engine.js";
import type { EndgameEngine } from "../game/endgame-engine.js";
import type { GameRepository } from "../db/repository.js";
import {
  createGame,
  PARENT_MESSAGE_CAP,
  transition,
  concernDeltaForTier,
  selectDueRung,
  CONSULT_DECAY,
  THERAPY_DECAY,
  CPS_STAY_DECAY,
  THERAPY_TURN_CAP,
} from "../game/state-machine.js";
import { generateFirstPortrait, generateNextPortrait } from "../portrait-gen.js";
import { withGameLock } from "../lib/game-lock.js";
import { randomBytes } from "crypto";
import {
  type Session,
  type Player,
  type PlayerSlot,
  createSession,
  addPlayer,
  setReady,
  allReady,
  resetReady,
  getPlayer,
  getPlayerBySlot,
  getPlayerByToken,
  reconnectPlayer,
  disconnectPlayer,
} from "../game/session-manager.js";
import {
  SOCKET_EVENTS as E,
  type CreateGamePayload,
  type JoinGamePayload,
  type ReadyPayload,
  type ParentMessagePayload,
  type TherapyMessagePayload,
  type AdultChatPayload,
  type PersonalityPayload,
  type TypingPayload,
  type LobbyState,
  type ViewerState,
} from "./protocol.js";
import { generatePersonalitySeed } from "../game/personality.js";
import { moderateParentMessage, applyModerationBlock, recordConcern } from "../safety/moderation.js";
import { evaluateEscalation } from "../safety/escalation.js";
import { getSocketIp } from "../lib/client-ip.js";
import { buildSceneTranscript } from "../game/context-assembler.js";
import { captureException } from "../observability/sentry.js";
import { generateMultiplayerAlbums } from "../game/album-generator.js";
import { logger } from "../logger.js";

export interface SocketDeps {
  io: Server;
  games: Map<string, GameState>;
  sessions: Map<string, Session>;
  conversationEngine: ConversationEngine;
  endgameEngine: EndgameEngine;
  repo: GameRepository;
  gameLocks?: Map<string, Promise<void>>;
  /** Lifetime of a device-handoff code. Injectable so tests can expire one
   * without waiting; production always takes the default. */
  handoffTtlMs?: number;
}

/**
 * How long a device-handoff code stays redeemable.
 *
 * Long enough to walk outside and find the message you sent yourself; short
 * enough that a link left in a chat history is inert by the time anyone else
 * reads it. Single-use is the stronger of the two guarantees — this is the
 * backstop for a code that is minted and then never used.
 */
const HANDOFF_TTL_MS = 10 * 60 * 1000;

/** A minted, not-yet-redeemed handoff code's binding. */
interface HandoffClaim {
  gameId: string;
  slot: PlayerSlot;
  expiresAt: number;
}

/**
 * Deliberately identical for every rejection reason — expired, already
 * redeemed, never existed, or minted for a different game. Distinguishing them
 * would turn the JOIN handler into an oracle for probing codes.
 */
const HANDOFF_REJECTED = "That link has expired or was already used. Ask for a new one from the device you were playing on.";

interface SocketData {
  gameId?: string;
  slot?: Sender;
}

// Mirrors routes/game.ts's MAX_MESSAGE_LENGTH — REST's /therapy-message
// enforces this cap but the socket THERAPY_MESSAGE handler didn't, so an
// over-length therapy message could reach the therapist-LLM unrejected on
// this transport. PARENT_MESSAGE has no length guard on either transport
// today, so there's nothing to mirror there; this constant exists only for
// THERAPY_MESSAGE parity with REST.
const MAX_MESSAGE_LENGTH = 2000;

/**
 * A game rehydrated from the database can come back in `event_intro` holding
 * the PREVIOUS scene's event, which is a state the live state machine never
 * produces (LOAD_EVENT is guarded on `currentEvent === null`).
 *
 * Why it happens: `reconstructState` (db/repository.ts) rebuilds `currentEvent`
 * as `events.find(e => e.eventNumber === currentEventNumber)`, but END_DEBRIEF
 * and END_INTERVENTION set `currentEvent: null` WITHOUT advancing
 * `currentEventNumber`. So a game parked between scenes persists as
 * "phase=event_intro, current_event_number=N" while the events table still
 * holds scene N — and any reload (JOIN after the 4h eviction sweep, a
 * reconnect into a restarted process, an invite link resumed later) resurrects
 * scene N as if it were pending.
 *
 * Two things then go wrong, both reported from live play: the event_intro
 * screen renders the previous scene's description (playtest note 7), and the
 * READY recovery branch calls beginChat() on it, dropping both players back
 * into the scene they just finished, transcript and all.
 *
 * `event_intro` + a loaded event is only ever a within-lock transient here, so
 * normalising it away on rehydration is lossless: the pair simply generate a
 * fresh scene at the next gate. The durable fix belongs in `reconstructState`
 * (the games row cannot represent "no current event"); this keeps the socket
 * transport correct in the meantime.
 */
function normalizeRehydrated(state: GameState): GameState {
  if (
    state.phase === "event_intro" &&
    state.currentEvent !== null &&
    sceneAlreadyPlayed(state)
  ) {
    return { ...state, currentEvent: null };
  }
  return state;
}

/**
 * Room holding every socket currently authenticated to one parent slot.
 *
 * STATE cannot be a plain room broadcast the way LOBBY/GENERATING/DOC_CHUNK are
 * — `viewerState` is slot-specific (it filters `visibleTo`, which is what keeps
 * a sidebar private). But addressing it to `player.connectionId`, a single
 * remembered socket id, made STATE the only message in the protocol that a
 * second socket for the same player never receives.
 *
 * `reconnectPlayer` overwrites `connectionId` and `addPlayer`'s
 * disconnected-slot reclaim replaces the whole player entry, while socket.io
 * leaves the superseded socket in the game room. That socket then keeps getting
 * LOBBY, GENERATING, KID_CHUNK and MESSAGE_DONE, and never another STATE: ready
 * counts and "building the next scene…" tick along live on top of a game view
 * frozen at whatever scene it last received. Every symptom of a "stuck" client
 * follows from that one asymmetry.
 *
 * A per-slot room fixes it at the addressing layer: every socket that joined as
 * that slot is a member, sockets that have gone away are removed by socket.io
 * itself, and the privacy boundary is unchanged (a slot room only ever contains
 * sockets that authenticated to that slot).
 */
function slotRoom(gameId: string, slot: Sender): string {
  return `${gameId}:${slot}`;
}

/**
 * Whether the scene at `currentEventNumber` has already been played out.
 *
 * Two independent signals, because either can be absent:
 * - real family-chat messages stamped with this event number (debrief messages
 *   are the two parents talking afterwards, so they don't count as the scene
 *   being live); and
 * - an identity snapshot for this event number. `endChat` has no minimum
 *   message count, so a scene ended with zero parent messages leaves no
 *   messages at all — but IDENTITY_UPDATED always pushes a snapshot stamped
 *   with the finished scene's number, which makes it the reliable marker.
 */
function sceneAlreadyPlayed(state: GameState): boolean {
  return (
    state.messages.some(
      (m) => m.eventNumber === state.currentEventNumber && m.chatType !== "debrief"
    ) ||
    state.identitySnapshots.some((s) => s.eventNumber === state.currentEventNumber)
  );
}

function viewerState(state: GameState, slot: Sender, generating: boolean): ViewerState {
  const messages = state.messages.filter((m) => m.visibleTo.includes(slot));
  const otherSlot = slot === "parent1" ? "parent2" : "parent1";
  return {
    id: state.id,
    phase: state.phase,
    childName: state.childName,
    childGender: state.childGender,
    relationshipType: state.relationshipType,
    currentEvent: state.currentEvent,
    currentEventNumber: state.currentEventNumber,
    totalEvents: state.totalEvents,
    messages,
    parentMessageCount: state.parentMessageCount,
    messagesRemaining: PARENT_MESSAGE_CAP - state.parentMessageCount,
    sidebarActive: state.sidebarActive,
    sidebarUsed: state.sidebarUsed,
    interventionText: state.interventionText,
    therapyMessages: state.therapyMessages,
    generating,
    partnerPersonalitySubmitted: !!state.parentPersonalities[otherSlot],
  };
}

function lobbyState(session: Session): LobbyState {
  return {
    gameId: session.gameId,
    players: session.players.map((p) => ({
      slot: p.slot,
      displayName: p.displayName,
      ready: p.ready,
      connected: p.connected,
    })),
  };
}

export function registerSocketHandlers(deps: SocketDeps): void {
  const { io, games, sessions, conversationEngine, endgameEngine, repo,
          gameLocks = new Map<string, Promise<void>>(),
          handoffTtlMs = HANDOFF_TTL_MS } = deps;

  const lock = <T>(gameId: string, fn: () => Promise<T>) => withGameLock(gameLocks, gameId, fn);

  // Games whose multiplayer album generation has already been kicked off, so a
  // duplicate REPORT_CARD (either client may emit it) triggers it only once —
  // album moments are a bare INSERT and would otherwise be duplicated.
  const albumGenerated = new Set<string>();

  // Games with a scenario generation in flight right now. This is the SOURCE OF
  // TRUTH behind ViewerState.generating — set before the (long) world-manager
  // await and cleared in the matching `finally`, so every STATE broadcast,
  // reconnect and fresh join reports the truth instead of relying on a client
  // having caught a one-shot GENERATING event. Never inferred from phase.
  const generatingGames = new Set<string>();

  // Games whose first scene has been kicked off (in flight or done). Scene 1 is
  // no longer triggered by a ready gate but by the personality seed landing, and
  // SUBMIT_PERSONALITY is re-emittable by design (a retry, a double-click, a
  // co-parent who reloads and retakes the quiz). Without this a second submit
  // would re-run the world manager on top of a scene the pair may already be
  // playing. Deleted again if the generation fails, so a retry can still work.
  const firstSceneStarted = new Set<string>();

  // Next-event prefetches, keyed by game — the multiplayer twin of the map in
  // routes/game.ts. Kicked off when a scene ends so the world-manager call runs
  // in parallel with the psychologist/identity-document pass and the debrief
  // beat, instead of making the pair sit through the full ~20s wait at the
  // event_intro gate. Promises are pre-caught to null: an orphaned prefetch
  // (game abandoned, provider error) must be inert, never an unhandled
  // rejection, and a null simply falls back to the synchronous loadEvent path.
  const prefetchedEvents = new Map<string, Promise<GameEvent | null>>();

  /**
   * Live device-handoff codes, keyed by the code itself.
   *
   * In memory only, and never written to the database or a log line. That is a
   * deliberate limit as much as a precaution: a code is redeemable only against
   * the process that minted it, and a restart invalidates every outstanding one
   * (the player simply asks for another). Sessions themselves are already
   * process-local — a restart rebuilds them from `repo.loadPlayers` — so this
   * adds no new failure mode, and it keeps a slot-granting credential out of
   * every durable store we operate.
   *
   * Bounded without a sweeper: minting drops the previous code for the same
   * {gameId, slot} and clears anything expired, so a client hammering
   * REQUEST_HANDOFF holds at most one live entry per slot it occupies.
   */
  const handoffCodes = new Map<string, HandoffClaim>();

  function mintHandoffCode(gameId: string, slot: PlayerSlot): HandoffClaim & { code: string } {
    const now = Date.now();
    for (const [existing, claim] of handoffCodes) {
      // Expired, or superseded by the code we're about to mint. Asking again
      // must invalidate the answer you were given before — otherwise every
      // press of the button leaves another live credential behind.
      if (claim.expiresAt <= now || (claim.gameId === gameId && claim.slot === slot)) {
        handoffCodes.delete(existing);
      }
    }
    // 128 bits of CSPRNG entropy, url-safe: 22 characters, no escaping, short
    // enough to text yourself, far too large to guess or enumerate.
    const code = randomBytes(16).toString("base64url");
    const claim: HandoffClaim = { gameId, slot, expiresAt: now + handoffTtlMs };
    handoffCodes.set(code, claim);
    return { ...claim, code };
  }

  /**
   * Validate and burn a handoff code. Returns null for every failure mode; the
   * caller reports them all identically (see HANDOFF_REJECTED).
   *
   * The delete happens before the expiry and game checks on purpose: a code is
   * spent the moment it is presented, whatever the outcome. A rejected attempt
   * that left the code alive would let an interceptor retry it against every
   * game id they know.
   */
  function consumeHandoffCode(code: string, gameId: string): HandoffClaim | null {
    const claim = handoffCodes.get(code);
    if (!claim) return null;
    handoffCodes.delete(code);
    if (claim.expiresAt <= Date.now()) return null;
    if (claim.gameId !== gameId) return null;
    return claim;
  }

  /**
   * Tell the socket that was holding this slot that a different live socket has
   * taken over, so the device the player walked away from says so instead of
   * leaving a ready button that silently does nothing.
   *
   * What this deliberately does NOT do is evict that socket: it stays in the
   * game and slot rooms and keeps receiving STATE, which is a supported and
   * tested state ("STATE reaches every socket a player has open"). The superseded
   * device therefore stays in sync and can take the game back in one press.
   *
   * Gated on the previous socket being live in this process. A page reload or a
   * dropped-and-redialled socket has already gone, so neither produces a
   * takeover notice — only a genuinely concurrent second device (or second tab)
   * does. Re-binding the same socket id (the ordinary auto-rejoin on reconnect)
   * is a no-op.
   */
  function supersedeActiveSocket(player: Player, newConnectionId: string): void {
    if (!player.connectionId || player.connectionId === newConnectionId) return;
    const previous = io.sockets.sockets.get(player.connectionId);
    if (!previous?.connected) return;
    previous.emit(E.SUPERSEDED, { slot: player.slot });
  }

  function startPrefetch(state: GameState): void {
    if (state.currentEventNumber >= state.totalEvents) return;
    prefetchedEvents.set(
      state.id,
      conversationEngine.prefetchNextEvent(state).catch((err) => {
        logger.error("prefetch_next_event_failed", {
          gameId: state.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
    );
  }

  function broadcastState(gameId: string): void {
    const state = games.get(gameId);
    const session = sessions.get(gameId);
    if (!state || !session) return;
    const generating = generatingGames.has(gameId);
    for (const player of session.players) {
      // No `connected` gate: a genuinely departed player's slot room is empty,
      // so this is a no-op for them — whereas gating on the flag meant any
      // player whose entry was momentarily marked disconnected, or superseded
      // by a newer socket, stopped receiving STATE while every other event in
      // the protocol kept arriving. See slotRoom.
      io.to(slotRoom(gameId, player.slot)).emit(
        E.STATE,
        viewerState(state, player.slot, generating)
      );
    }
  }

  function broadcastLobby(gameId: string): void {
    const session = sessions.get(gameId);
    if (!session) return;
    io.to(gameId).emit(E.LOBBY, lobbyState(session));
  }

  /**
   * Build and begin scene 1 — driven by the personality seed, not by a ready
   * gate.
   *
   * The opening used to generate this scene at the lobby gate, which put it
   * *before* the OCEAN quiz: the world manager ran with `personalitySeed: ""`
   * and an empty `parentPersonalities`, so the first thing anyone played was
   * the one scene in the game that knew nothing about them. Calling it here,
   * from SUBMIT_PERSONALITY once the seed exists, is the whole point of the
   * reorder — `seeded` must therefore be the post-seed state, never the state
   * the handler started from.
   *
   * Ready flags deliberately survive the opening gate (they are what holds each
   * player on the guardian screen — see the READY handler) and are cleared here,
   * once there is a scene to clear them into.
   */
  async function startFirstScene(gameId: string, seeded: GameState): Promise<void> {
    if (firstSceneStarted.has(gameId)) return;
    firstSceneStarted.add(gameId);

    generatingGames.add(gameId);
    io.to(gameId).emit(E.GENERATING, { generating: true });
    broadcastState(gameId);
    try {
      const next = conversationEngine.beginChat(await conversationEngine.loadEvent(seeded));
      // Same crash-safe save order as the READY path: the event row lands
      // before the game row, so a crash in between regenerates cleanly.
      if (next.currentEvent) await repo.saveEvent(next.id, next.currentEvent);
      games.set(next.id, next);
      await repo.saveGame(next);
      generateNextPortrait(gameId).catch(() => {});
    } catch (err) {
      // Let a retry through: the seed is already persisted, so re-readying from
      // the lobby (see the `finally`) takes the normal needsFreshScene path and
      // regenerates the scene still personality-informed.
      firstSceneStarted.delete(gameId);
      throw err;
    } finally {
      generatingGames.delete(gameId);
      // STATE first, then LOBBY. A LOBBY carrying ready=false that arrives
      // before the STATE carrying currentEventNumber === 1 reads, on the
      // client, as "pre-game and not readied" — i.e. a flash of the lobby on
      // top of a scene that already exists.
      broadcastState(gameId);
      io.to(gameId).emit(E.GENERATING, { generating: false });
      const session = sessions.get(gameId);
      if (session) sessions.set(gameId, resetReady(session));
      broadcastLobby(gameId);
    }
  }

  /**
   * End-of-chat helper: runs the psychologist / identity-doc flow, saves
   * snapshot + game, resets ready flags, and broadcasts updated state.
   *
   * This function is intentionally lock-free — callers must ensure
   * serialization themselves (either by calling from within an existing
   * `withGameLock` block, or wrapping the call in one).
   */
  async function endChat(gameId: string, ipAddress: string | null): Promise<void> {
    const state = games.get(gameId);
    const session = sessions.get(gameId);
    if (!state || !session) return;
    if (state.phase !== "family_chat") return;

    // Kick the next scene off NOW, so the world manager runs in parallel with
    // the psychologist below and with however long the pair spend in the
    // debrief — rather than serially at the event_intro gate, where two people
    // sat watching "building the next scene…" for the whole call. This mirrors
    // the solo/HTTP path (routes/game.ts end-chat). It reuses the current
    // identity document, one scene behind: guidance queued by *this* scene's
    // trajectory check lands in the following scene's prefetch. A natural
    // one-scene delay, not a bug.
    //
    // Placed after the phase guard above so a duplicate END_CHAT (double-click,
    // reconnect, retry) cannot start a second world-manager call.
    startPrefetch(state);

    const emitChunk = (chunk: string) => {
      io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
    };

    /**
     * Put the `processing` phase on the wire BEFORE the psychologist call, not
     * after it.
     *
     * `endFamilyChat` runs END_FAMILY_CHAT (→ processing) and IDENTITY_UPDATED
     * (→ debrief) internally and returns only once both are done, so without
     * this every client jumped `family_chat` → `debrief` and `ProcessingScreen`
     * — whose fragments exist precisely to cover this call — never rendered.
     * Live that read as "walk away" doing nothing for ~60 seconds: same screen,
     * same transcript, button still live. The prefetch above widened the hole
     * by moving more waiting here.
     *
     * In-memory only, deliberately: no `repo.saveGame`. `processing` is a
     * transient the game must never be *rehydrated* into — a crash between here
     * and IDENTITY_UPDATED has to come back as `family_chat` so the END_CHAT
     * recovery path (see the message-cap branch) can re-run this whole
     * function. Persisting it would strand the game in a phase nothing can
     * advance. Reconnects inside this process read the live `games` map and so
     * still see `processing`.
     *
     * Free side effect worth naming: with the map holding `processing`, this
     * function's own `phase !== "family_chat"` guard makes a duplicate END_CHAT
     * a no-op for the whole duration of the call, instead of only for the
     * instant before it.
     */
    const onProcessing = (processingState: GameState) => {
      games.set(gameId, processingState);
      broadcastState(gameId);
    };

    const { state: next, sceneSafety } = await conversationEngine.endFamilyChat(
      state,
      emitChunk,
      onProcessing
    );
    const snap = next.identitySnapshots[next.identitySnapshots.length - 1];
    if (snap) await repo.saveSnapshot(next.id, snap);

    if (sceneSafety.tier === "block") {
      const lastParentMessage = [...next.messages].reverse().find((m) => m.sender !== "kid");
      await applyModerationBlock({
        repo,
        games,
        state: next,
        sender: lastParentMessage?.sender ?? "parent1",
        content: buildSceneTranscript(next),
        reason: sceneSafety.reason,
        ipAddress,
        banIp: false, // Scene-level block is an LLM judgment — end session + persist a flag for human review; do NOT auto-ban (only the reliable per-message OpenAI check auto-bans).
      });
      io.to(gameId).emit(E.ERROR, { error: "This session has ended." });
      broadcastState(gameId);
      return;
    }

    if (sceneSafety.tier === "concern") {
      const lastParentMessage = [...next.messages].reverse().find((m) => m.sender !== "kid");
      await recordConcern({
        repo,
        state: next,
        sender: lastParentMessage?.sender ?? "parent1",
        reason: sceneSafety.reason,
        ipAddress,
      });
      // NOTE: session continues. In-fiction consequences are handled by the
      // trajectory system today and the intervention ladder (Plan 3) later.

      // Dark Play Plan 4: only on a Tier A concern outcome (a clean/none
      // scene can't push an IP into all-dark, and a block already returned
      // above) — evaluate the cross-game ratio and, at most, write a
      // reviewable flag. Never allowed to break the scene.
      evaluateEscalation({ repo, ip: ipAddress, gameId: next.id }).catch((err) => {
        logger.error("escalation_evaluation_error", {
          gameId: next.id,
          error: err instanceof Error ? err.stack : String(err),
        });
      });
    }

    // Dark Play Plan 2: net concern accrues once per scene, at scene end.
    // The "block" path already returned above; here the tier is "concern" or
    // "none", so this raises (concern) or decays (clean) the accumulator.
    const accrued = transition(next, {
      type: "CONCERN_ACCRUED",
      delta: concernDeltaForTier(sceneSafety.tier),
    });

    games.set(accrued.id, accrued);
    await repo.saveGame(accrued);
    sessions.set(gameId, resetReady(session));
    io.to(gameId).emit(E.DOC_DONE, { documentType: "identity" });
    broadcastState(gameId);
    broadcastLobby(gameId);
  }

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;

    function fail(message: string): void {
      socket.emit(E.ERROR, { error: message });
    }

    // Report an unexpected socket-handler error to Sentry/GlitchTip (no-op
    // unless SENTRY_DSN is set), then surface it to the client via `fail`.
    // These handlers catch their own exceptions, so the global uncaught/
    // unhandled handlers never see them — capture must happen here.
    function failWithError(err: unknown, event: string): void {
      captureException(err, { tags: { component: "socket", event } });
      fail(String(err));
    }

    function currentState(): GameState | undefined {
      const state = data.gameId ? games.get(data.gameId) : undefined;
      if (!state) return state;
      // Repair-on-read, with write-back so the shared map converges: any
      // transport can seed `games` from the repository (lib/resolve-game.ts),
      // and only this normalisation keeps a rehydrated between-scenes game from
      // handing the READY handler a scene it has already played.
      const repaired = normalizeRehydrated(state);
      if (repaired !== state) games.set(state.id, repaired);
      return repaired;
    }

    // ---- CREATE_GAME ----
    socket.on(E.CREATE_GAME, async (payload: CreateGamePayload) => {
      if (!payload?.childName) return fail("childName is required");
      const state = createGame(payload.childName, payload.relationshipType);
      games.set(state.id, state);
      await repo.saveGame(state);
      // Dark Play Plan 4: record the creating IP — the denominator prerequisite
      // for escalation detection (see safety/escalation.ts). Not part of
      // GameState; written directly to the games row.
      await repo.recordGameIp(state.id, getSocketIp(socket));

      let session = createSession(state.id);
      const added = addPlayer(session, socket.id, payload.displayName, payload.userId);
      session = added.session;
      sessions.set(state.id, session);

      data.gameId = state.id;
      data.slot = added.player.slot;
      await socket.join(state.id);
      await socket.join(slotRoom(state.id, added.player.slot));

      await repo.savePlayer(state.id, added.player.slot, added.player.displayName, added.player.token, added.player.userId);
      socket.emit(E.JOINED, { gameId: state.id, slot: added.player.slot, playerToken: added.player.token });
      broadcastLobby(state.id);
      generateFirstPortrait(state.id).catch(() => {});
    });

    // ---- JOIN_GAME (new join OR reconnect) ----
    socket.on(E.JOIN_GAME, async (payload: JoinGamePayload) => {
      const gameId = payload?.gameId;
      if (!gameId) return fail("gameId is required");

      // Redeem a device-handoff code FIRST, and synchronously — before the
      // first await in this handler. Single-use has to mean single-use under
      // concurrency: two sockets presenting the same code (the player's phone
      // and a chat app's link prefetcher, say) must not both get past this
      // point, and anything after an await could interleave. The claim is
      // burned here; the slot is bound below, once the session is resolved.
      let handoff: HandoffClaim | null = null;
      if (typeof payload?.handoffCode === "string" && payload.handoffCode.length > 0) {
        handoff = consumeHandoffCode(payload.handoffCode, gameId);
        // Never echo the code back — not in this message, not anywhere.
        if (!handoff) return fail(HANDOFF_REJECTED);
      }

      // Load game state if not in memory
      let state = games.get(gameId);
      if (!state) {
        const loaded = await repo.loadGame(gameId);
        if (loaded) {
          games.set(gameId, loaded);
          state = loaded;
        }
      }
      if (!state) return fail("Game not found");

      // Repair the one state the persistence layer cannot represent faithfully
      // (see normalizeRehydrated). Applied to the resolved state, not just to a
      // fresh reload: `lib/resolve-game.ts` seeds the SAME games map from the
      // repo on any REST touch, so the map can already hold an unrepaired
      // reload by the time a player joins.
      const repaired = normalizeRehydrated(state);
      if (repaired !== state) {
        games.set(gameId, repaired);
        state = repaired;
      }

      // Restore session from DB if not in memory
      let session = sessions.get(gameId) ?? createSession(gameId);
      if (session.players.length === 0) {
        const dbPlayers = await repo.loadPlayers(gameId);
        for (const rec of dbPlayers) {
          session = {
            ...session,
            players: [
              ...session.players,
              {
                slot: rec.slot as PlayerSlot,
                connectionId: "",
                displayName: rec.displayName,
                ready: false,
                connected: false,
                token: rec.token,
                userId: rec.userId,
              },
            ],
          };
        }
        sessions.set(gameId, session);
      }

      // ---- Device handoff: this socket takes over the slot the code was
      // minted for. Deliberately routed through the very same reconnect path a
      // returning player uses — the handoff's only job is to establish *which*
      // slot, after which this is an ordinary reconnect and inherits all of its
      // behaviour, including preserving the player's ready flag.
      if (handoff) {
        const player = getPlayerBySlot(session, handoff.slot);
        // The slot has no player record at all: the game was reset or the
        // players row is gone. Nothing to hand off to.
        if (!player) return fail(HANDOFF_REJECTED);

        supersedeActiveSocket(player, socket.id);
        const moved = reconnectPlayer(session, player.token, socket.id);
        session = moved.session;
        sessions.set(gameId, session);
        data.gameId = gameId;
        data.slot = moved.player.slot;
        await socket.join(gameId);
        await socket.join(slotRoom(gameId, moved.player.slot));
        // The new device gets the ordinary long-lived credential, which it
        // stores exactly as a first join would. From here it is indistinguishable
        // from the device that started the session.
        socket.emit(E.JOINED, { gameId, slot: moved.player.slot, playerToken: moved.player.token });
        broadcastLobby(gameId);
        socket.emit(
          E.STATE,
          viewerState(state, moved.player.slot, generatingGames.has(gameId))
        );
        return;
      }

      // Token-based reconnect: returning player reclaims their slot
      if (payload.playerToken) {
        const existing = getPlayerByToken(session, payload.playerToken);
        if (existing) {
          // Symmetry with the handoff path: if a *live* socket currently holds
          // this slot, it is being taken over and must be told. This is what
          // makes the reverse direction (taking the game back on the device you
          // handed off from) non-silent — without it the phone would keep a
          // ready button that no longer reaches the server.
          supersedeActiveSocket(existing, socket.id);
          const reconnected = reconnectPlayer(session, payload.playerToken, socket.id);
          session = reconnected.session;
          sessions.set(gameId, session);
          data.gameId = gameId;
          data.slot = reconnected.player.slot;
          await socket.join(gameId);
          await socket.join(slotRoom(gameId, reconnected.player.slot));
          socket.emit(E.JOINED, { gameId, slot: reconnected.player.slot, playerToken: reconnected.player.token });
          broadcastLobby(gameId);
          // Reconnect used to emit STATE but never GENERATING, so a returning
          // client kept whatever stale generating flag it had. The flag now
          // rides on STATE itself, which closes that hole (playtest note 7).
          socket.emit(
            E.STATE,
            viewerState(state, reconnected.player.slot, generatingGames.has(gameId))
          );
          return;
        }
      }

      // New player: assign to first free slot
      let added;
      try {
        added = addPlayer(session, socket.id, payload.displayName, payload.userId);
      } catch {
        return fail("This game already has two players");
      }
      session = added.session;
      sessions.set(gameId, session);

      data.gameId = gameId;
      data.slot = added.player.slot;
      await socket.join(gameId);
      await socket.join(slotRoom(gameId, added.player.slot));

      await repo.savePlayer(gameId, added.player.slot, added.player.displayName, added.player.token, added.player.userId);
      socket.emit(E.JOINED, { gameId, slot: added.player.slot, playerToken: added.player.token });
      broadcastLobby(gameId);
      socket.emit(
        E.STATE,
        viewerState(state, added.player.slot, generatingGames.has(gameId))
      );
    });

    // ---- REQUEST_HANDOFF ----
    // "Can I keep playing from my phone?" Answers with a code, to this socket
    // alone, that another device can exchange for this slot.
    //
    // Authorisation is the socket binding itself: `data.slot` was set by a
    // CREATE/JOIN this connection already completed, so a socket can only ever
    // mint for the slot it is playing. There is deliberately no REST equivalent
    // — see REQUEST_HANDOFF in protocol.ts.
    //
    // The code is emitted and then forgotten. It is never logged (not here, not
    // on redemption, not on failure), never broadcast to the room, and never
    // persisted; the co-parent has no way to observe that it happened.
    socket.on(E.REQUEST_HANDOFF, () => {
      const gameId = data.gameId;
      const slot = data.slot;
      if (!gameId || !slot || slot === "kid") return fail("Not in a game");
      const minted = mintHandoffCode(gameId, slot);
      socket.emit(E.HANDOFF_CODE, { code: minted.code, expiresAt: minted.expiresAt });
    });

    // ---- READY ----
    // Serialized through the per-game lock so concurrent or duplicate READY
    // events (e.g. a player clicking "ready" several times while a scenario is
    // still generating) can't each fire their own event generation. Crucially,
    // ready flags are cleared BEFORE the long generation await, so a re-entrant
    // READY sees allReady=false and is a no-op. Previously this handler was
    // lock-free and only reset ready AFTER loadEvent returned, so extra clicks
    // spawned multiple loadEvent() calls whose scenarios clobbered each other
    // (rapidly-swapping / stuck scenarios).
    socket.on(E.READY, async (payload: ReadyPayload) => {
      const gameId = data.gameId;
      if (!gameId) return fail("Not in a game");

      await lock(gameId, async () => {
        const session = sessions.get(gameId);
        const state = currentState();
        if (!session || !state) return fail("Not in a game");

        sessions.set(gameId, setReady(session, socket.id, !!payload?.ready));
        broadcastLobby(gameId);

        // ---- The opening gate does not generate anything ----
        // Scene 1 is built from the personality seed (see startFirstScene), and
        // the seed does not exist until both parents have finished the guardian
        // quiz. Generating here is what made the first scene of every game
        // personality-blind, and it is what put a ~20s "building the next
        // scene…" wait in front of a questionnaire that needs neither the scene
        // nor a second player.
        //
        // The ready flags are deliberately NOT reset and NOT waited on for both
        // players: this one flag, read back off the LOBBY broadcast, is what
        // takes a player into the quiz. It is per-player (the lobby's own button
        // is disabled until both parents are connected, so it still can't fire
        // before the pair exists), it is server-owned, and it survives long
        // enough to be the durable answer to "has this player passed the
        // lobby?" — which nothing in GameState records. resetReady() here would
        // yank both clients back to the lobby mid-quiz. startFirstScene clears
        // them once scene 1 exists.
        const awaitingPersonality =
          state.phase === "event_intro" &&
          state.currentEventNumber === 0 &&
          state.personalitySeed === "";
        if (awaitingPersonality) {
          // The creating player has never received a STATE at this point:
          // CREATE_GAME emits JOINED + LOBBY only, and JOIN_GAME's STATE goes to
          // the joiner alone. Previously the gate's own generation broadcast one
          // as a side effect; now that nothing generates here, without this the
          // creator's client holds `state === null`, can't tell it has passed
          // the lobby, and never enters the quiz — so the second personality
          // never arrives and the game sits there.
          broadcastState(gameId);
          return;
        }

        const updated = sessions.get(gameId)!;
        if (!allReady(updated)) return;

        // Both ready → advance exactly once. Clear ready flags up front so any
        // duplicate READY arriving during the await below is a no-op.
        sessions.set(gameId, resetReady(updated));
        broadcastLobby(gameId);

        try {
          // A fresh scene is needed when no scenario is loaded, and ALSO when
          // the loaded scenario has already been played out. The latter is the
          // "it dropped us back into the same conversation" report: a
          // rehydrated game can arrive at event_intro still holding the last
          // finished scene (see normalizeRehydrated), and the recovery branch
          // below would beginChat() straight back into it — same event, same
          // transcript. Playing a scene twice is never the right answer, so it
          // routes here instead.
          const needsFreshScene =
            state.phase === "event_intro" &&
            (state.currentEvent === null || sceneAlreadyPlayed(state));

          if (needsFreshScene) {
            // One gate takes the pair all the way into the chat: obtain the
            // scenario, then begin the chat inside the same lock.
            //
            // This used to stop after loadEvent and demand a SECOND both-ready
            // round. In production that stranded 9 of 13 fully-joined games in
            // event_intro with zero messages and no exception logged — two
            // people cannot reliably re-synchronise across a ~20s model call
            // while the UI silently clears the ready flags they just set.
            generatingGames.add(gameId);
            io.to(gameId).emit(E.GENERATING, { generating: true });
            // Broadcast immediately so the flag reaches clients on STATE too,
            // not only via the fire-and-forget GENERATING event.
            broadcastState(gameId);
            try {
              // LOAD_EVENT is guarded on `currentEvent === null`, so a stale
              // already-played scenario has to be cleared before we regenerate.
              const base =
                state.currentEvent === null ? state : { ...state, currentEvent: null };

              // Consume the prefetch started at scene end (endChat). When one
              // is available this gate costs nothing; otherwise — first scene
              // of the game, a failed prefetch, or a game rehydrated in another
              // process — fall back to the synchronous world-manager call.
              const pending = prefetchedEvents.get(gameId);
              prefetchedEvents.delete(gameId);
              const prefetched = pending ? await pending : null;

              // applyPrefetchedEvent reduces START_EVENT, which lands directly
              // in family_chat — beginChat() after it would be an illegal
              // transition. Only the loadEvent path needs the second step.
              const next = prefetched
                ? conversationEngine.applyPrefetchedEvent(base, prefetched)
                : conversationEngine.beginChat(await conversationEngine.loadEvent(base));

              // Save order is deliberate and crash-safe: the event row lands
              // BEFORE the game row. Crashing in between leaves the games row
              // one scene back, which regenerates cleanly (saveEvent upserts on
              // (game_id, event_number)). The reverse order would persist
              // "family_chat at scene N+1" with no scene N+1 row — a chat with
              // no scenario, unrecoverable.
              if (next.currentEvent) await repo.saveEvent(next.id, next.currentEvent);
              games.set(next.id, next);
              await repo.saveGame(next);
              generateNextPortrait(gameId).catch(() => {});
            } finally {
              // Order matters. Clearing the flag first means the STATE below
              // already carries `generating: false` alongside the new scene, so
              // the authoritative update lands as one consistent frame. The
              // GENERATING event goes out AFTER it: emitting it first left a
              // window where a client held generating=false against a stale
              // event_intro STATE and briefly rendered a live ready button.
              generatingGames.delete(gameId);
              broadcastState(gameId);
              io.to(gameId).emit(E.GENERATING, { generating: false });
              broadcastLobby(gameId);
            }
          } else if (state.phase === "event_intro" && state.currentEvent !== null) {
            // Recovery path: games left mid-handshake by the old two-round gate
            // still have a scenario and no messages against it. One gate
            // finishes them. Guarded by needsFreshScene above, so this can only
            // begin a scene that has genuinely never been played.
            const next = conversationEngine.beginChat(state);
            games.set(next.id, next);
            await repo.saveGame(next);
            broadcastState(gameId);
            broadcastLobby(gameId);
            generateNextPortrait(gameId).catch(() => {});
          } else if (state.phase === "debrief") {
            // Dark Play Plan 3 — the intervention ladder takes priority over
            // both the epilogue-vs-next-scene branch below: a due rung
            // reroutes the game into consult/therapy/cps_review instead of
            // event_intro. Only when no rung is due does the existing
            // (unchanged) epilogue-vs-next-scene logic run.
            const rung = selectDueRung(state.concernLevel, state.highestRungFired);
            if (rung > 0) {
              const emitChunk = (chunk: string) => {
                io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
              };
              const result =
                rung === 1
                  ? await conversationEngine.generateConsult(state, emitChunk)
                  : rung === 2
                  ? await conversationEngine.openTherapy(state, emitChunk)
                  : await endgameEngine.runCpsReview(state, emitChunk);
              games.set(result.state.id, result.state);
              await repo.saveGame(result.state);
              // Close the DOC_CHUNK stream so clients clear streamingDocText —
              // the intervention text now lives in state (interventionText /
              // therapyMessages) and the screen reads it from there. Without
              // this the accumulated buffer leaks into the next ProcessingScreen.
              io.to(gameId).emit(E.DOC_DONE, { documentType: "intervention" });
              broadcastState(gameId);
              broadcastLobby(gameId);
            } else if (state.currentEventNumber >= state.totalEvents) {
              const emitChunk = (chunk: string) => {
                io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
              };
              const result = await endgameEngine.generateEpilogue(state, emitChunk);
              games.set(result.state.id, result.state);
              await repo.saveGame(result.state);
              broadcastState(gameId);
              broadcastLobby(gameId);
              io.to(gameId).emit(E.EPILOGUE, { epilogue: result.epilogue });
            } else {
              const next = conversationEngine.endDebrief(state);
              games.set(next.id, next);
              await repo.saveGame(next);
              broadcastState(gameId);
              broadcastLobby(gameId);
            }
          } else if (state.phase === "consult") {
            let next = transition(state, { type: "CONCERN_ACCRUED", delta: -CONSULT_DECAY });
            next = transition(next, { type: "END_INTERVENTION" });
            games.set(next.id, next);
            await repo.saveGame(next);
            broadcastState(gameId);
            broadcastLobby(gameId);
          } else if (state.phase === "therapy") {
            let next = transition(state, { type: "CONCERN_ACCRUED", delta: -THERAPY_DECAY });
            next = transition(next, { type: "END_INTERVENTION" });
            games.set(next.id, next);
            await repo.saveGame(next);
            broadcastState(gameId);
            broadcastLobby(gameId);
          } else if (state.phase === "cps_review") {
            if (state.cpsOutcome === "removal") {
              const emitChunk = (chunk: string) => {
                io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
              };
              const result = await endgameEngine.generateRemovalEpilogue(state, emitChunk);
              games.set(result.state.id, result.state);
              await repo.saveGame(result.state);
              broadcastState(gameId);
              broadcastLobby(gameId);
              io.to(gameId).emit(E.EPILOGUE, { epilogue: result.epilogue });
            } else {
              // "stay" | "safety_plan" — never bans, never skips decay.
              let next = transition(state, { type: "CONCERN_ACCRUED", delta: -CPS_STAY_DECAY });
              next = transition(next, { type: "END_INTERVENTION" });
              games.set(next.id, next);
              await repo.saveGame(next);
              broadcastState(gameId);
              broadcastLobby(gameId);
            }
          }
        } catch (err) {
          // Ready flags were already cleared above; just surface the error.
          failWithError(err, "READY");
        }
      });
    });

    // ---- PARENT_MESSAGE ----
    socket.on(E.PARENT_MESSAGE, (payload: ParentMessagePayload) => {
      const gameId = data.gameId;
      const slot = data.slot;
      if (!gameId || !slot) return fail("Not in a game");
      if (slot === "kid") return fail("Invalid sender");
      if (!payload?.content?.trim()) return;

      lock(gameId, async () => {
        const state = currentState();
        const session = sessions.get(gameId);
        if (!state || !session) { fail("Not in a game"); return; }

        // A terminated session must not accept further input.
        if (state.phase === "ended") {
          fail("This session has ended.");
          return;
        }

        if (state.phase === "sidebar" && state.sidebarActive !== slot) {
          fail("The other parent is in a private conversation");
          return;
        }

        const moderation = await moderateParentMessage({
          repo,
          games,
          state,
          sender: slot,
          content: payload.content.trim(),
          ipAddress: getSocketIp(socket),
        });
        if (moderation.blocked) {
          fail("This session has ended.");
          broadcastState(gameId);
          return;
        }

        // ---- Debrief chat ----
        // "Later that night. The kids are asleep. It's just you two." The one
        // screen in the game where two humans talk to each other with nothing
        // generating between them: append, persist, broadcast — no kid LLM
        // turn, no scene-end detection, no message cap, no endChat. The
        // reducer stamps chatType "debrief" and visibleTo [parent1, parent2],
        // which keeps it out of every LLM context (they all filter through
        // currentEventMessages(), which admits only shared|private) and out of
        // the per-scene message count (repository.ts reconstructState).
        //
        // Moderation still runs above: this is player-typed free text in a
        // game about a child, so the Tier B bright line applies here too.
        if (state.phase === "debrief") {
          const next = transition(state, {
            type: "PARENT_MESSAGE",
            sender: slot,
            content: payload.content.trim(),
          });
          games.set(next.id, next);
          const appended = next.messages[next.messages.length - 1];
          if (appended) await repo.saveMessage(next.id, appended);
          await repo.saveGame(next);
          broadcastState(gameId);
          // Nothing streams here, but the client clears its in-flight send
          // state on MESSAGE_DONE, so the round trip still has to be closed.
          io.to(gameId).emit(E.MESSAGE_DONE, {});
          return;
        }

        const inSidebar = state.phase === "sidebar";
        const emitChunk = (chunk: string) => {
          const filtered = chunk.replace(/\[SCENE_END\]/g, "");
          if (!filtered) return;
          if (inSidebar) {
            // Slot room, not `socket` — a private sidebar belongs to the
            // PLAYER, so every socket that parent has open should see the
            // stream, and no socket belonging to the other parent should.
            io.to(slotRoom(gameId, slot)).emit(E.KID_CHUNK, { text: filtered });
          } else {
            io.to(gameId).emit(E.KID_CHUNK, { text: filtered });
          }
        };

        const result = await conversationEngine.handleParentMessage(
          state,
          slot,
          payload.content.trim(),
          emitChunk
        );

        // Mid-scene safety interception: a "block" verdict terminates
        // immediately rather than letting a bad-faith actor keep going until
        // the scene ends; a "concern" verdict records and continues.
        if (result.sceneSafety?.tier === "block") {
          const lastParent = [...result.state.messages].reverse().find((m) => m.sender !== "kid");
          await applyModerationBlock({
            repo,
            games,
            state: result.state,
            sender: lastParent?.sender ?? slot,
            content: buildSceneTranscript(result.state),
            reason: result.sceneSafety.reason,
            ipAddress: getSocketIp(socket),
            banIp: false, // Scene-level block is an LLM judgment — end session + persist a flag for human review; do NOT auto-ban (only the reliable per-message OpenAI check auto-bans).
          });
          fail("This session has ended.");
          broadcastState(gameId);
          return;
        }

        if (result.sceneSafety?.tier === "concern") {
          const lastParent = [...result.state.messages].reverse().find((m) => m.sender !== "kid");
          await recordConcern({
            repo,
            state: result.state,
            sender: lastParent?.sender ?? slot,
            reason: result.sceneSafety.reason,
            ipAddress: getSocketIp(socket),
          });
          // NOTE: session continues — fall through to the normal message flow below.
        }

        // Detect and strip the [SCENE_END] sentinel before saving/broadcasting
        const sceneEnded = result.kidResponse.includes("[SCENE_END]");
        if (sceneEnded) {
          result.kidResponse = result.kidResponse.replace(/\s*\[SCENE_END\]\s*/g, "").trim();
          const msgs = result.state.messages;
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg) {
            lastMsg.content = lastMsg.content.replace(/\s*\[SCENE_END\]\s*/g, "").trim();
          }
        }

        games.set(result.state.id, result.state);
        const tail = result.state.messages.slice(-2);
        for (const m of tail) await repo.saveMessage(result.state.id, m);
        await repo.saveGame(result.state);

        broadcastState(gameId);
        io.to(gameId).emit(E.MESSAGE_DONE, {});

        // Auto-end the scene if the kid ended it naturally or the cap is reached.
        // Skip during sidebar: emitting SCENE_ENDED mid-sidebar locks both clients
        // since the endChat phase guard returns early, leaving no recovery path.
        if (!inSidebar && (sceneEnded || result.state.parentMessageCount >= PARENT_MESSAGE_CAP)) {
          io.to(gameId).emit(E.SCENE_ENDED, {});
          await endChat(gameId, getSocketIp(socket));
        }
      }).catch((err) => failWithError(err, "PARENT_MESSAGE"));
    });

    // ---- THERAPY_MESSAGE ----
    // Dark Play Plan 3, Rung 2. Distinct from PARENT_MESSAGE (guarded to
    // family_chat) so the two flows stay unambiguous. Guarded to `therapy`
    // and to THERAPY_TURN_CAP parent turns; streams the therapist's reply via
    // DOC_CHUNK the same way endChat streams the psychologist's document.
    socket.on(E.THERAPY_MESSAGE, (payload: TherapyMessagePayload) => {
      const gameId = data.gameId;
      const slot = data.slot;
      if (!gameId || !slot) return fail("Not in a game");
      if (slot === "kid") return fail("Invalid sender");
      if (!payload?.content?.trim()) return;

      lock(gameId, async () => {
        const state = currentState();
        if (!state) { fail("Not in a game"); return; }

        // Idempotency / stale-client guard, mirroring endChat's phase check —
        // a double-click or a reconnect after the session already concluded
        // must not re-run the LLM or re-append a turn.
        if (state.phase !== "therapy") {
          broadcastState(gameId);
          return;
        }

        const parentTurns = state.therapyMessages.filter((m) => m.speaker === "parent").length;
        if (parentTurns >= THERAPY_TURN_CAP) {
          fail("This therapy session must be concluded.");
          return;
        }

        const trimmedContent = payload.content.trim();
        if (trimmedContent.length > MAX_MESSAGE_LENGTH) {
          fail(`content must be ${MAX_MESSAGE_LENGTH} characters or fewer`);
          return;
        }

        // Same reliable per-message OpenAI check PARENT_MESSAGE runs (see
        // above) — the Rung-2 therapy session is still the player typing
        // free text, so the Tier B bright line (sexual/minors) must apply
        // here too, before the content reaches the therapist-LLM.
        const moderation = await moderateParentMessage({
          repo,
          games,
          state,
          sender: slot,
          content: trimmedContent,
          ipAddress: getSocketIp(socket),
        });
        if (moderation.blocked) {
          fail("This session has ended.");
          broadcastState(gameId);
          return;
        }

        const emitChunk = (chunk: string) => {
          io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
        };
        const result = await conversationEngine.therapistReply(state, trimmedContent, emitChunk);
        games.set(result.state.id, result.state);
        await repo.saveGame(result.state);
        // Close the DOC_CHUNK stream so clients clear streamingDocText; the
        // therapist reply is now in state.therapyMessages (rebroadcast below).
        io.to(gameId).emit(E.DOC_DONE, { documentType: "therapy" });
        broadcastState(gameId);
      }).catch((err) => failWithError(err, "THERAPY_MESSAGE"));
    });

    // ---- TYPING ----
    // Co-presence only. Deliberately does nothing else: no lock, no state
    // machine, no persistence, no rate limit beyond what the client's own
    // debounce provides. `socket.to(room)` excludes the sender, so a player
    // never sees their own typing indicator echoed back. Silently ignored when
    // the socket is not in a game — a stray ping is not worth an ERROR frame.
    socket.on(E.TYPING, (payload: TypingPayload) => {
      const gameId = data.gameId;
      const slot = data.slot;
      if (!gameId || !slot) return;
      socket.to(gameId).emit(E.TYPING, { slot, typing: !!payload?.typing });
    });

    socket.on(E.START_SIDEBAR, () => {
      const gameId = data.gameId;
      const slot = data.slot;
      const state = currentState();
      if (!gameId || !slot || slot === "kid" || !state) return fail("Not in a game");
      try {
        const next = conversationEngine.startSidebar(state, slot);
        games.set(next.id, next);
        broadcastState(gameId);
      } catch (err) {
        failWithError(err, "START_SIDEBAR");
      }
    });

    socket.on(E.END_SIDEBAR, () => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      try {
        const next = conversationEngine.endSidebar(state);
        games.set(next.id, next);
        broadcastState(gameId);
      } catch (err) {
        failWithError(err, "END_SIDEBAR");
      }
    });

    socket.on(E.END_CHAT, () => {
      const gameId = data.gameId;
      if (!gameId) return fail("Not in a game");

      lock(gameId, async () => {
        await endChat(gameId, getSocketIp(socket));
      }).catch((err) => failWithError(err, "END_CHAT"));
    });

    socket.on(E.START_EPILOGUE, async () => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      try {
        const emitChunk = (chunk: string) => {
          io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
        };
        const result = await endgameEngine.generateEpilogue(state, emitChunk);
        games.set(result.state.id, result.state);
        await repo.saveGame(result.state);
        broadcastState(gameId);
        io.to(gameId).emit(E.EPILOGUE, { epilogue: result.epilogue });
      } catch (err) {
        failWithError(err, "START_EPILOGUE");
      }
    });

    socket.on(E.ADULT_CHAT, async (payload: AdultChatPayload) => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      if (!payload?.scenario) return fail("scenario is required");
      try {
        const next = await endgameEngine.startAdultConversation(state, payload.scenario);
        games.set(next.id, next);
        await repo.saveGame(next);
        broadcastState(gameId);
      } catch (err) {
        failWithError(err, "ADULT_CHAT");
      }
    });

    socket.on(E.REPORT_CARD, async (payload: { epilogue?: string }) => {
      const gameId = data.gameId;
      const state = currentState();
      if (!gameId || !state) return fail("Not in a game");
      try {
        const emitChunk = (chunk: string) => {
          io.to(gameId).emit(E.DOC_CHUNK, { text: chunk });
        };
        const result = await endgameEngine.generateReportCard(state, payload?.epilogue ?? "", emitChunk);
        games.set(result.state.id, result.state);
        await repo.saveEndgame(result.state.id, payload?.epilogue ?? "", result.reportCard);
        await repo.saveGame(result.state);
        broadcastState(gameId);
        io.to(gameId).emit(E.REPORT_CARD_READY, { reportCard: result.reportCard });

        // Fire-and-forget: build each signed-in player's Family Album, grouping
        // this game under their co-parent. Guarded so a duplicate REPORT_CARD
        // (either client can emit it) kicks it off only once. Never blocks or
        // throws into the handler; per-player failures are isolated inside.
        const session = sessions.get(gameId);
        if (session && !albumGenerated.has(gameId)) {
          albumGenerated.add(gameId);
          const players = session.players.map((p) => ({ userId: p.userId, displayName: p.displayName }));
          void generateMultiplayerAlbums({
            engine: endgameEngine,
            repo,
            state: result.state,
            epilogue: payload?.epilogue ?? "",
            reportCard: result.reportCard,
            players,
          }).catch((e) => {
            logger.error("mp_album_generation_failed", { gameId, error: (e as Error).message });
          });
        }
      } catch (err) {
        failWithError(err, "REPORT_CARD");
      }
    });

    // ---- SUBMIT_PERSONALITY ----
    socket.on(E.SUBMIT_PERSONALITY, (payload: PersonalityPayload) => {
      const gameId = data.gameId;
      const slot = data.slot;
      if (!gameId || !slot || slot === "kid") return fail("Not in a game");

      const { ocean, confessional1, confessional2 } = payload ?? {};

      // Validate ocean
      if (
        !Array.isArray(ocean) ||
        ocean.length !== 5 ||
        !ocean.every((v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4)
      ) {
        return fail("ocean must be an array of 5 integers each between 1 and 4");
      }

      const MAX_CONFESSIONAL_LENGTH = 500;
      if (
        (confessional1 !== undefined && (typeof confessional1 !== "string" || confessional1.length > MAX_CONFESSIONAL_LENGTH)) ||
        (confessional2 !== undefined && (typeof confessional2 !== "string" || confessional2.length > MAX_CONFESSIONAL_LENGTH))
      ) {
        return fail("confessionals must be strings of at most 500 characters");
      }

      const personality: ParentPersonality = {
        ocean: ocean as [number, number, number, number, number],
        confessional1: confessional1 ?? "",
        confessional2: confessional2 ?? "",
      };

      lock(gameId, async () => {
        const state = currentState();
        if (!state) { fail("Not in a game"); return; }

        const updatedState: GameState = {
          ...state,
          parentPersonalities: {
            ...state.parentPersonalities,
            [slot]: personality,
          },
        };
        games.set(gameId, updatedState);

        // Broadcast that this slot has submitted
        io.to(gameId).emit(E.PERSONALITY_SUBMITTED, { slot });
        // …and again on STATE, where it survives a reconnect. The waiting step
        // of the guardian screen reads it to say which of the two waits it is
        // actually in — "still waiting on your co-parent" is not the same thing
        // as "the seed is generating", and only one of them is ever true.
        broadcastState(gameId);

        // Determine readiness: solo needs only parent1; multiplayer needs both
        const isSolo =
          updatedState.relationshipType === "solo parent" ||
          updatedState.relationshipType === "solo";

        const parent1 = updatedState.parentPersonalities.parent1;
        const parent2 = updatedState.parentPersonalities.parent2;
        const allPersonalitiesReady = isSolo ? !!parent1 : !!(parent1 && parent2);

        if (allPersonalitiesReady && parent1) {
          const seed = await generatePersonalitySeed(
            conversationEngine.llm,
            updatedState.childName,
            parent1,
            isSolo ? undefined : parent2
          );
          const withSeed: GameState = { ...updatedState, personalitySeed: seed };
          games.set(gameId, withSeed);
          await repo.saveGame(withSeed);
          io.to(gameId).emit(E.PERSONALITY_SEED_READY, { personalitySeed: seed });

          // The reorder's whole point: scene 1 is generated HERE, from
          // `withSeed`, so the world manager sees the personality seed and both
          // parents' personalities. Passing `updatedState` (the pre-seed state)
          // or re-reading via currentState() before the games.set above would
          // silently reproduce the exact bug this replaces.
          //
          // Only for the opening — a co-parent submitting late (routes/game.ts
          // allows it) must never regenerate the scene that is already running.
          if (withSeed.phase === "event_intro" && withSeed.currentEventNumber === 0) {
            await startFirstScene(gameId, withSeed);
          }
        } else {
          await repo.saveGame(updatedState);
        }
      }).catch((err) => failWithError(err, "SUBMIT_PERSONALITY"));
    });

    // ---- DISCONNECT: mark disconnected, don't remove ----
    socket.on("disconnect", () => {
      const gameId = data.gameId;
      if (!gameId) return;
      const session = sessions.get(gameId);
      if (!session) return;
      if (getPlayer(session, socket.id)) {
        const updated = disconnectPlayer(session, socket.id);
        sessions.set(gameId, updated);
        if (updated.players.some((p) => p.connected)) {
          broadcastLobby(gameId);
        }
      }
    });
  });
}
