import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { TestClient, connect, submitPersonalities } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { LobbyState, ViewerState } from "../src/socket/protocol.js";
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

function readyFlags(lobby: LobbyState | undefined): Record<string, boolean> {
  return Object.fromEntries((lobby?.players ?? []).map((p) => [p.slot, p.ready]));
}

/**
 * The opening's two model calls, and what happened when either of them failed.
 *
 * Since the 2026-07-31 reorder, SUBMIT_PERSONALITY runs `generatePersonalitySeed`
 * and then `startFirstScene` — both through llm/routing-client.ts, whose
 * `AbortSignal.timeout(90_000)` is the whole budget (`withRetry` deliberately
 * does not retry timeouts). This is the same failure the READY gate had at
 * `event_intro`, one screen earlier, and it was invisible in three ways:
 *
 *  1. the catch was `failWithError(err, "SUBMIT_PERSONALITY")`, a socket-scoped
 *     emit — and the submit that reaches it is whichever one completed the
 *     pair, so the other parent, on the identical screen, heard nothing;
 *  2. what it emitted was `String(err)` — raw exception text;
 *  3. `GuardianScreen` rendered no error surface at all, so neither string was
 *     shown even to the socket that got one.
 *
 * And underneath all three, the reason a surface on that screen would not have
 * helped on its own: `startFirstScene`'s `finally` cleared the ready flags on
 * the failure path too, which on the client makes `preGame && !meReady` — i.e.
 * `inLobbyView`, evaluated *before* `showGuardian` — so both parents were
 * silently returned to the lobby, discarding the quiz answers and confessionals
 * they had just typed. The flags are what hold a player on the guardian screen;
 * a failed opening now leaves them alone.
 */
describe("a failed opening is said to both parents, and retries from where they are", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  let repo: InMemoryGameRepository;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new MockLLMClient();
    repo = new InMemoryGameRepository();
    built = buildServer({
      llm: mock,
      repo,
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

  /** Two connected players in a fresh game. */
  async function pair(childName: string): Promise<[TestClient, TestClient, string]> {
    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await joined2;
    return [p1, p2, gameId];
  }

  it("tells BOTH parents when scene 1 fails, in words, and recovers on a resubmit", async () => {
    // The seed call succeeds (the mock always answers `completeResponse`); the
    // world manager finds no queued event and throws, which is the mock's
    // stand-in for the 90s abort.
    mock.events = [];

    const [p1, p2, gameId] = await pair("Wren");

    const failed1 = p1.waitFor<{ error: string }>(E.ERROR);
    const failed2 = p2.waitFor<{ error: string }>(E.ERROR);
    submitPersonalities(p1, p2);

    // Both. This is the half `failWithError` could never do: only the submit
    // that completed the pair reached its socket-scoped emit, so the parent who
    // answered first sat on the closing beat of the guardian screen with no
    // account of anything at all.
    const [e1, e2] = await Promise.all([failed1, failed2]);
    expect(e1.error).toBe("the first scene didn't finish building. try again.");
    expect(e2.error).toBe(e1.error);
    // Never raw exception text. `String(err)` here was
    // "Error: No mock events available"; in production, for the failure this
    // was written from, "TimeoutError: The operation was aborted due to
    // timeout". Both would be caught by this.
    expect(e1.error).not.toMatch(/error|timeout|abort|exception|failed|undefined|\bat\s/i);

    await new Promise((r) => setTimeout(r, 50));

    // The ready flags SURVIVE the failure. Without this the message above is
    // broadcast to a screen neither player is still on: clearing them makes the
    // client's `inLobbyView` true, which is checked before `showGuardian`, so
    // both parents get bounced to the lobby and lose the quiz. This assertion
    // is what pins the fix rather than the surface.
    expect(readyFlags(p1.lastLobby)).toEqual({ parent1: true, parent2: true });
    expect(readyFlags(p2.lastLobby)).toEqual({ parent1: true, parent2: true });

    // And they are held there over a game that genuinely has no scene yet, with
    // nothing claiming to be generating.
    expect(p1.lastState?.phase).toBe("event_intro");
    expect(p1.lastState?.currentEventNumber).toBe(0);
    expect(p1.lastState?.currentEvent).toBeNull();
    expect(p1.lastState?.generating).toBe(false);

    // "try again" is a live control, not a consolation: re-emitting
    // SUBMIT_PERSONALITY is exactly what the button does, and it must land the
    // pair in a playable scene. Either parent can press it — this is the one
    // who did NOT complete the original pair.
    mock.events = [mockEvent(1)];
    const recovered = p2.waitFor<ViewerState>(
      E.STATE,
      (s) => s.phase === "family_chat" && s.currentEvent != null
    );
    p1.emit(E.SUBMIT_PERSONALITY, {
      ocean: [3, 2, 4, 2, 3],
      confessional1: "I told my sister her hamster ran away.",
      confessional2: "",
    });
    const scene = await recovered;
    expect(scene.currentEvent?.description).toContain("Scenario 1");
    expect(scene.currentEventNumber).toBe(1);

    // A recovered opening is still personality-informed — the retry regenerates
    // the seed rather than building the scene blind, which is the whole reason
    // the reorder moved scene 1 behind the quiz in the first place.
    // `personalitySeed` is server-side only, so read the persisted game.
    const saved = await repo.loadGame(gameId);
    expect(saved!.personalitySeed).not.toBe("");

    // …and now, with a scene to clear them into, the flags do reset, so the
    // next gate (the debrief) is a real gate.
    await new Promise((r) => setTimeout(r, 50));
    expect(readyFlags(p1.lastLobby)).toEqual({ parent1: false, parent2: false });
  });

  it("distinguishes the earlier failure — the personality seed — from scene 1", async () => {
    // The opening's FIRST model call fails, so `startFirstScene` is never
    // entered. Saying "the first scene didn't finish building" here would be a
    // lie about which thing broke, and the message is the only thing the player
    // has to reason with.
    mock.throwOnPersonalitySeed = true;
    mock.events = [mockEvent(1)];

    const [p1, p2, gameId] = await pair("Bo");

    const failed1 = p1.waitFor<{ error: string }>(E.ERROR);
    const failed2 = p2.waitFor<{ error: string }>(E.ERROR);
    submitPersonalities(p1, p2);

    const [e1, e2] = await Promise.all([failed1, failed2]);
    expect(e1.error).toBe("their personality didn't finish forming. try again.");
    expect(e2.error).toBe(e1.error);
    expect(e1.error).not.toMatch(/error|timeout|abort|exception|failed|undefined|\bat\s/i);

    // This is the path that stranded players outright: no `startFirstScene`
    // means no `finally`, so nothing ever cleared the ready flags and nothing
    // ever reset `generating` — both parents simply waited on the closing beat
    // forever. The flags being true is now the intended state rather than an
    // accident of which call failed, and it is the same state as the scene-1
    // case above, so one surface covers both.
    await new Promise((r) => setTimeout(r, 50));
    expect(readyFlags(p1.lastLobby)).toEqual({ parent1: true, parent2: true });
    expect(p1.lastState?.currentEvent).toBeNull();

    // Same retry, same button, and it clears both calls in one press.
    mock.throwOnPersonalitySeed = false;
    const recovered = p1.waitFor<ViewerState>(
      E.STATE,
      (s) => s.phase === "family_chat" && s.currentEvent != null
    );
    p2.emit(E.SUBMIT_PERSONALITY, {
      ocean: [2, 4, 1, 3, 2],
      confessional1: "I broke a window and blamed the neighbour's kid.",
      confessional2: "",
    });
    const scene = await recovered;
    expect(scene.currentEvent?.description).toContain("Scenario 1");
    const saved = await repo.loadGame(gameId);
    expect(saved!.personalitySeed).not.toBe("");
  });
});
