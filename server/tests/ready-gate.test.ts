import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { TestClient, connect, submitPersonalities } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import type { GameEvent } from "../src/types.js";

function mockEvent(n: number): GameEvent {
  return {
    eventNumber: n,
    age: 3,
    description: `Scenario ${n}.`,
    setting: "Home",
    trigger: "Test",
  };
}

/**
 * Production evidence (2026-07-29): of 13 multiplayer games where both players
 * joined, 9 produced zero messages and were stuck in `event_intro` — 4 before a
 * scenario existed, 5 after one had been generated. GlitchTip recorded no
 * socket-path exception for any of them, so nothing crashed; the players simply
 * never completed the handshake.
 *
 * The cause was that reaching family chat took TWO separate both-ready rounds
 * (one to generate the scenario, one to begin the chat) with the ready flags
 * silently cleared in between and no signal that generation was underway. Two
 * humans had to synchronise twice across a ~20s model call, with the UI showing
 * their clicks being undone.
 *
 * One gate must be enough: both ready → guardian quiz → chat begins.
 *
 * Amended 2026-07-31 (opening reorder): the gate itself no longer generates
 * anything. Readying takes each player into the guardian quiz; scene 1 is built
 * when the personality seed lands, so the world manager finally sees the seed
 * and both parents. The gate count is unchanged — one — and the single-flight
 * guarantee moved with the generation, from READY to SUBMIT_PERSONALITY.
 */
describe("Multiplayer ready gate", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new MockLLMClient();
    built = buildServer({
      llm: mock,
      repo: new InMemoryGameRepository(),
      adminQueries: new InMemoryAdminQueries(),
      enableEviction: false,
      allowedOrigin: "*",
      socketPath: "/socket.io",
    });
    await new Promise<void>((resolve) => {
      built.httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await built.close();
  });

  async function client(): Promise<TestClient> {
    const c = await connect(baseUrl);
    clients.push(c);
    return c;
  }

  /** Two joined players in a fresh game, ready to be readied. */
  async function pair(childName: string) {
    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await joined2;

    return { p1, p2, gameId };
  }

  it("carries both players from the lobby into family chat with no second gate", async () => {
    mock.events = [mockEvent(1), mockEvent(2)];
    const { p1, p2 } = await pair("Solo");

    // Register both waiters before emitting, so a fast transition can't be missed.
    const chat1 = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    const chat2 = p2.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");

    // Ready → guardian quiz → personality submitted → scene. Still exactly one
    // ready round; what changed in the 2026-07-31 reorder is that the round no
    // longer generates anything, and the quiz sits between it and the scene.
    submitPersonalities(p1, p2);

    const s1 = await chat1;
    const s2 = await chat2;

    // Both players land in the chat, with the scenario attached, from ONE gate.
    expect(s1.phase).toBe("family_chat");
    expect(s2.phase).toBe("family_chat");
    expect(s1.currentEvent).not.toBeNull();
    expect(s1.currentEvent?.description).toContain("Scenario 1");
    expect(p1.lastError).toBeUndefined();
    expect(p2.lastError).toBeUndefined();
  });

  it("does not generate anything at the lobby gate — the quiz comes first", async () => {
    // The reorder's load-bearing negative: readying up must leave the game in
    // event_intro with no scenario, because the world manager cannot run until
    // the personality seed exists. Regressing this makes scene 1
    // personality-blind again without failing any positive assertion.
    mock.events = [mockEvent(1)];
    const { p1, p2 } = await pair("Patience");

    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    await new Promise((r) => setTimeout(r, 250));

    expect(mock.events.length).toBe(1); // untouched
    // BOTH players must hold a STATE here. The creator gets none from
    // CREATE_GAME (JOINED + LOBBY only) and none from the joiner's JOIN, so
    // before the gate broadcast one explicitly their client sat on
    // `state === null`, could not tell it had passed the lobby, never entered
    // the quiz, and the second personality never arrived.
    expect(p1.lastState?.phase).toBe("event_intro");
    expect(p1.lastState?.currentEventNumber).toBe(0);
    expect(p2.lastState?.phase).toBe("event_intro");
    expect(p2.lastState?.currentEventNumber).toBe(0);
    expect(p1.states().every((s) => s.currentEvent === null)).toBe(true);
    expect(p2.states().every((s) => s.currentEvent === null)).toBe(true);
    // The ready flags survive: they are what holds each player on the guardian
    // screen, and clearing them here would bounce both clients to the lobby
    // mid-quiz.
    expect(p1.lastLobby?.players.every((pl) => pl.ready)).toBe(true);
    expect(p1.lastError).toBeUndefined();
  });

  it("announces that the scenario is generating once the personality seed lands", async () => {
    mock.events = [mockEvent(1)];
    const { p1, p2 } = await pair("Signal");

    const generating = p2.waitFor<{ generating: boolean }>(
      E.GENERATING,
      (g) => g.generating === true
    );

    submitPersonalities(p1, p2);

    // The waiting player is told work is underway rather than seeing a silent reset.
    await expect(generating).resolves.toMatchObject({ generating: true });
  });

  it("still generates exactly one scenario when both players spam ready", async () => {
    // Single-flight guarantee from the 2026-07-23 playtest fix must survive the
    // collapse of the two rounds into one — and now also the move of generation
    // off the gate entirely.
    mock.events = [mockEvent(1), mockEvent(2)];
    const { p1, p2 } = await pair("Spam");

    const chat = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    for (let i = 0; i < 3; i++) {
      p1.emit(E.READY, { ready: true });
      p2.emit(E.READY, { ready: true });
    }
    submitPersonalities(p1, p2, { ready: false });
    await chat;
    await new Promise((r) => setTimeout(r, 250));

    // Exactly one event consumed out of the two loaded.
    expect(mock.events.length).toBe(1);
    expect(p1.lastError).toBeUndefined();
  });

  it("generates exactly one scenario when a parent re-submits their personality", async () => {
    // The new single-flight surface. SUBMIT_PERSONALITY is re-emittable by
    // design (retry button, double-click, a co-parent who reloads and retakes
    // the quiz), and a second run of the world manager would clobber the scene
    // the pair are already playing.
    mock.events = [mockEvent(1), mockEvent(2)];
    const { p1, p2 } = await pair("Resubmit");

    const chat = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
    submitPersonalities(p1, p2);
    await chat;

    submitPersonalities(p1, p2, { ready: false });
    await new Promise((r) => setTimeout(r, 250));

    expect(mock.events.length).toBe(1);
    expect(p1.lastState?.phase).toBe("family_chat");
    expect(p1.lastState?.currentEvent?.description).toContain("Scenario 1");
  });
});
