import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import type { AddressInfo } from "net";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { EndgameEngine } from "../src/game/endgame-engine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { registerSocketHandlers } from "../src/socket/handlers.js";
import type { Session } from "../src/game/session-manager.js";
import type { GameEvent, GameState, Message } from "../src/types.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { LobbyState, ViewerState } from "../src/socket/protocol.js";
import { TestClient, connect } from "./helpers/socket-client.js";

/**
 * Device handoff — "if they step outside, can they continue from their phone?"
 *
 * The credential that answers that question is a short-lived, single-use code
 * bound to {gameId, slot}, exchanged over JOIN_GAME for the ordinary
 * playerToken. These tests pin the properties that make it safe to put in a
 * link: it works exactly once, it dies on its own, and it is worthless against
 * any game but the one it was minted for.
 */

function mockEvent(n: number): GameEvent {
  return {
    eventNumber: n,
    age: 3 + n,
    description: `Scenario ${n}.`,
    setting: "Home",
    trigger: `Trigger ${n}`,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("device handoff", () => {
  let httpServer: HttpServer;
  let io: SocketServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  const clients: TestClient[] = [];

  /**
   * Boot a bare socket server around the real handlers. Deliberately not the
   * full app: `handoffTtlMs` is injected here so the expiry test can watch a
   * code die in milliseconds instead of ten minutes, and no fake timers have to
   * be pointed at a live socket.io connection.
   */
  async function boot(handoffTtlMs?: number): Promise<void> {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new MockLLMClient();
    mock.events = Array.from({ length: 6 }, (_, i) => mockEvent(i + 1));
    mock.kidResponses = ["I didn't mean to."];
    httpServer = createServer();
    io = new SocketServer(httpServer);
    registerSocketHandlers({
      io,
      games: new Map<string, GameState>(),
      sessions: new Map<string, Session>(),
      conversationEngine: new ConversationEngine(mock),
      endgameEngine: new EndgameEngine(mock),
      repo: new InMemoryGameRepository(),
      handoffTtlMs,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  }

  async function client(): Promise<TestClient> {
    const c = await connect(baseUrl);
    clients.push(c);
    return c;
  }

  interface Pair {
    p1: TestClient;
    p2: TestClient;
    gameId: string;
    token2: string;
  }

  /** A game with both parent slots filled, parked in the opening lobby. */
  async function pair(childName: string): Promise<Pair> {
    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName, displayName: "Alex" });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once<{ playerToken: string }>(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId, displayName: "Sam" });
    const { playerToken } = await joined2;

    return { p1, p2, gameId, token2: playerToken };
  }

  /** Ask for a handoff code as whichever slot `c` is playing. */
  async function mint(c: TestClient): Promise<string> {
    const minted = c.once<{ code: string; expiresAt: number }>(E.HANDOFF_CODE);
    c.emit(E.REQUEST_HANDOFF);
    const { code } = await minted;
    expect(code).toBeTruthy();
    return code;
  }

  beforeEach(async () => {
    await boot();
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  // ------------------------------------------------------ the code itself --

  it("mints a code that is unguessable and never echoes it in the lobby", async () => {
    const p = await pair("Wren");

    // The co-parent must not be able to observe that a handoff happened, let
    // alone the code — it goes to the requesting socket alone.
    const code = await mint(p.p2);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits, url-safe, no padding
    expect(JSON.stringify(p.p1.lastLobby ?? {})).not.toContain(code);
  });

  it("exchanges a code for the slot, and lets that code work exactly once", async () => {
    const p = await pair("Wren");
    const code = await mint(p.p2);

    // The phone.
    const phone = await client();
    const joined = phone.once<{ slot: string; playerToken: string }>(E.JOINED);
    phone.emit(E.JOIN_GAME, { gameId: p.gameId, handoffCode: code });
    const landed = await joined;

    // It lands on the slot the code was minted for, and is handed the ordinary
    // long-lived credential — from here it is an ordinary player.
    expect(landed.slot).toBe("parent2");
    expect(landed.playerToken).toBe(p.token2);

    // A second presentation of the same code — a re-opened link, a chat app
    // prefetching the URL, someone who saw it over a shoulder — gets nothing.
    const third = await client();
    const rejected = third.waitFor<{ error: string }>(E.ERROR);
    third.emit(E.JOIN_GAME, { gameId: p.gameId, handoffCode: code });
    expect((await rejected).error).toMatch(/expired or was already used/i);
    // …and no slot was granted.
    expect(third.lastState).toBeUndefined();
  });

  it("rejects an expired code", async () => {
    // A server whose codes live 20ms.
    for (const c of clients) c.close();
    clients.length = 0;
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await boot(20);

    const p = await pair("Wren");
    const code = await mint(p.p2);
    await delay(60);

    const phone = await client();
    const rejected = phone.waitFor<{ error: string }>(E.ERROR);
    phone.emit(E.JOIN_GAME, { gameId: p.gameId, handoffCode: code });
    expect((await rejected).error).toMatch(/expired or was already used/i);
    expect(phone.lastState).toBeUndefined();
  });

  it("will not redeem game A's code against game B", async () => {
    const a = await pair("Wren");
    const b = await pair("Ash");
    expect(a.gameId).not.toBe(b.gameId);

    const code = await mint(a.p2);

    const intruder = await client();
    const rejected = intruder.waitFor<{ error: string }>(E.ERROR);
    intruder.emit(E.JOIN_GAME, { gameId: b.gameId, handoffCode: code });
    await rejected;
    expect(intruder.lastState).toBeUndefined();

    // The code is spent by the attempt, not just refused by it: presenting it
    // is what burns it, so a wrong guess cannot be retried against every other
    // game id the holder knows.
    const retry = await client();
    const refused = retry.waitFor<{ error: string }>(E.ERROR);
    retry.emit(E.JOIN_GAME, { gameId: a.gameId, handoffCode: code });
    await refused;
    expect(retry.lastState).toBeUndefined();
  });

  it("refuses to mint for a socket that is not in a game", async () => {
    const stranger = await client();
    const failed = stranger.waitFor<{ error: string }>(E.ERROR);
    stranger.emit(E.REQUEST_HANDOFF);
    expect((await failed).error).toMatch(/not in a game/i);
  });

  // ---------------------------------------------------- what carries over --

  it("carries the player's ready state across the handoff", async () => {
    const p = await pair("Wren");

    // Parent 2 readies at the opening gate, then steps outside. Parent 1 has
    // not readied, so the gate is still open and the flag is observable.
    const readied = p.p1.waitFor<LobbyState>(
      E.LOBBY,
      (l) => l.players.find((pl) => pl.slot === "parent2")?.ready === true
    );
    p.p2.emit(E.READY, { ready: true });
    await readied;

    const code = await mint(p.p2);
    const phone = await client();
    const joinedPhone = phone.once(E.JOINED);
    phone.emit(E.JOIN_GAME, { gameId: p.gameId, handoffCode: code });
    await joinedPhone;

    // reconnectPlayer used to force `ready: false`, so handing off mid-gate
    // silently threw the click away and both players sat on "1 of 2 ready".
    const after = await p.p1.waitFor<LobbyState>(E.LOBBY, () => true, 2000).catch(() => p.p1.lastLobby!);
    const parent2 = (p.p1.lastLobby ?? after).players.find((pl) => pl.slot === "parent2")!;
    expect(parent2.ready).toBe(true);
    expect(parent2.connected).toBe(true);

    // And the gate still completes from the new device: parent 1 readies, both
    // are ready, the game advances. Nothing has to be re-clicked.
    const chatting = phone.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    p.p1.emit(E.READY, { ready: true });
    await chatting;
  });

  it("delivers STATE to the handed-off device on its own slot room", async () => {
    const p = await pair("Wren");

    const code = await mint(p.p2);
    const phone = await client();
    const joinedPhone = phone.once(E.JOINED);
    phone.emit(E.JOIN_GAME, { gameId: p.gameId, handoffCode: code });
    await joinedPhone;

    // Redemption itself answers with the current state, so the new device opens
    // on the scene in progress rather than an empty screen.
    expect(phone.lastState).toBeDefined();

    // Readied from the PHONE, which is what now holds the slot. (Readying from
    // the laptop would be a no-op — see the takeover test below.)
    const chatting = phone.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    p.p1.emit(E.READY, { ready: true });
    phone.emit(E.READY, { ready: true });
    await chatting;

    // The live broadcast reaches it too — this is the per-slot room, not a
    // remembered connection id.
    const heard = phone.waitFor<ViewerState>(E.STATE, (s) =>
      s.messages.some((m: Message) => m.content.includes("STEPPED_OUTSIDE"))
    );
    p.p1.emit(E.PARENT_MESSAGE, { content: "STEPPED_OUTSIDE are you still there?" });
    const seen = await heard;
    expect(seen.phase).toBe("family_chat");
  });

  // ----------------------------------------------- the superseded device --

  it("tells the device it was handed off from, instead of freezing it", async () => {
    const p = await pair("Wren");
    const code = await mint(p.p2);

    // The laptop is still open and still connected.
    const notified = p.p2.waitFor<{ slot: string }>(E.SUPERSEDED);
    const phone = await client();
    const joinedPhone = phone.once(E.JOINED);
    phone.emit(E.JOIN_GAME, { gameId: p.gameId, handoffCode: code });
    await joinedPhone;

    expect((await notified).slot).toBe("parent2");

    // WHY the notice is not optional: ready is keyed on the slot's current
    // connection, so the laptop's ready button no longer reaches the server.
    // Left unannounced this is a dead control on a live-looking screen — the
    // precise failure the per-slot-room work went in to remove. The client
    // renders a takeover screen on this event rather than that dead button.
    p.p2.emit(E.READY, { ready: true });
    await delay(50);
    expect(p.p1.lastLobby!.players.find((pl) => pl.slot === "parent2")!.ready).toBe(false);

    // Superseded is not evicted: STATE still reaches the old socket, so the
    // view behind the takeover notice stays current and taking the game back is
    // instant. (This is the invariant playtest-fixes.test.ts pins for a second
    // socket generally; the handoff must not quietly break it.)
    const oldStillSynced = p.p2.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    p.p1.emit(E.READY, { ready: true });
    phone.emit(E.READY, { ready: true });
    await oldStillSynced;
  });

  it("hands the game back symmetrically, notifying the device that had it", async () => {
    const p = await pair("Wren");
    const code = await mint(p.p2);

    const phone = await client();
    const joinedPhone = phone.once(E.JOINED);
    const supersededLaptop = p.p2.waitFor(E.SUPERSEDED);
    phone.emit(E.JOIN_GAME, { gameId: p.gameId, handoffCode: code });
    await joinedPhone;
    await supersededLaptop;

    // The laptop takes it back with the credential it still holds. The phone
    // gets the same notice the laptop just had — the loop closes, and neither
    // device is ever left with a ready button that goes nowhere.
    const supersededPhone = phone.waitFor<{ slot: string }>(E.SUPERSEDED);
    const rejoined = p.p2.once<{ slot: string }>(E.JOINED);
    p.p2.emit(E.JOIN_GAME, { gameId: p.gameId, playerToken: p.token2 });
    expect((await rejoined).slot).toBe("parent2");
    expect((await supersededPhone).slot).toBe("parent2");
  });

  it("does not raise a takeover notice for an ordinary reload", async () => {
    const p = await pair("Wren");

    // A reload tears the old socket down before the new one dials. Nobody is
    // sitting in front of a second device, so nobody should be told anything —
    // a spurious "you're playing elsewhere" screen on every refresh would be
    // worse than the bug it guards against.
    let sawSuperseded = false;
    p.p1.socket.on(E.SUPERSEDED, () => (sawSuperseded = true));
    p.p2.close();

    const reloaded = await client();
    const rejoined = reloaded.once(E.JOINED);
    reloaded.emit(E.JOIN_GAME, { gameId: p.gameId, playerToken: p.token2 });
    await rejoined;
    await delay(50);
    expect(sawSuperseded).toBe(false);
  });
});
