import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { TestClient, connect, openFirstScene } from "./helpers/socket-client.js";
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
 * Witnessed live (game 15443d38, 2026-07-31): "building the next scene…" ran
 * for exactly 90.0 seconds, then BOTH clients silently returned to
 * "the story continues… / ready for the next chapter / 0 of 2 ready" with no
 * error shown. The socket never dropped. Re-readying regenerated fine.
 *
 * 90.0s is the world manager's own budget:
 * `loadEvent` → `completeJson` → `completeResponse` (no onChunk) →
 * `AbortSignal.timeout(90_000)` in llm/routing-client.ts, and `withRetry`
 * deliberately does not retry timeouts, so the first abort is the whole story.
 *
 * The failure was invisible for two compounding reasons, both fixed here:
 *  1. the READY catch called `failWithError`, which emits to `socket` alone —
 *     and the READY that reaches that code is whichever one *completed* the
 *     pair, so one parent was never told anything at all;
 *  2. what it emitted was `String(err)`, i.e. raw exception text.
 *
 * This suite drives the same shape with the mock world manager: an empty
 * `mock.events` makes `completeJson` throw, exactly as an aborted call does.
 */
describe("scene generation failure is visible to both players", () => {
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

  it("tells both parents, in words, when the next scene fails to build — and the gate still retries", async () => {
    // Exactly one scenario, for scene 1. The end-of-scene prefetch then finds
    // nothing and fails (swallowed by design, see startPrefetch's .catch), and
    // the event_intro gate's fallback `loadEvent` fails too — the mock's
    // stand-in for the 90s abort.
    mock.events = [mockEvent(1)];

    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Wren" });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await joined2;

    await openFirstScene(p1, p2);

    const spoke = p2.once(E.MESSAGE_DONE);
    p1.emit(E.PARENT_MESSAGE, { content: "What happened at school today?" });
    await spoke;

    const debrief = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
    p1.emit(E.END_CHAT);
    await debrief;

    // debrief → event_intro. This gate generates nothing; it is the NEXT one
    // that calls the world manager, which is the gate the players watched
    // "building the next scene…" on.
    const between = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "event_intro");
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    await between;

    const failed1 = p1.once<{ error: string }>(E.ERROR);
    const failed2 = p2.once<{ error: string }>(E.ERROR);
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });

    // BOTH parents hear it. This is the half `failWithError` could never do:
    // its socket-scoped emit reached at most the player whose READY completed
    // the pair, leaving the other one staring at a gate with no explanation.
    const [e1, e2] = await Promise.all([failed1, failed2]);
    expect(e1.error).toBe("the next scene didn't finish building. ready up again to retry.");
    expect(e2.error).toBe(e1.error);
    // Never raw exception text. `String(err)` for the live failure was
    // "TimeoutError: The operation was aborted due to timeout".
    expect(e1.error).not.toMatch(/error|timeout|abort/i);

    // The gate the players were returned to is genuinely live — ready flags are
    // cleared before the generation await, and the inner `finally` broadcasts
    // generating:false — so "ready up again to retry" is a true instruction and
    // not a consolation. Prove it.
    await new Promise((r) => setTimeout(r, 50));
    expect(p1.lastState?.phase).toBe("event_intro");
    expect(p1.lastState?.currentEvent).toBeNull();

    mock.events = [mockEvent(2)];
    const recovered = p1.waitFor<ViewerState>(
      E.STATE,
      (s) => s.phase === "family_chat" && s.currentEvent != null
    );
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    const s = await recovered;
    expect(s.currentEvent?.description).toContain("Scenario 2");
  });
});
