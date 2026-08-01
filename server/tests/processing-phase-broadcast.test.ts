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
import type { LLMRole } from "../src/llm/model-config.js";

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
 * An LLM whose psychologist call can be held open indefinitely.
 *
 * This is the whole point of the test: the `processing` phase must reach the
 * clients WHILE the identity-document call is still running, because that call
 * is the ~60 seconds the screen exists to cover. A test that simply awaits
 * END_CHAT and then inspects the state log afterwards passes even with the bug
 * — by then both transitions have happened and the ordering is invisible.
 */
class GatedLLM extends MockLLMClient {
  psychStarted = false;
  psychResolved = false;
  private release!: () => void;
  private gate = new Promise<void>((resolve) => {
    this.release = () => {
      this.psychResolved = true;
      resolve();
    };
  });

  releasePsychologist(): void {
    this.release();
  }

  override async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    if (role === "psychologist") {
      this.psychStarted = true;
      await this.gate;
    }
    return super.completeResponse(system, userMessage, maxTokens, role, onChunk);
  }
}

/**
 * Regression for "walk away is visually dead for ~60 seconds" (live verification,
 * 2026-07-31, reproduced twice).
 *
 * `conversationEngine.endFamilyChat` runs END_FAMILY_CHAT (→ processing) and
 * IDENTITY_UPDATED (→ debrief) internally and only returns once both are done.
 * `endChat` broadcast nothing in between, so clients sampling the phase saw
 * `family_chat` → `debrief` and never `processing`: `ProcessingScreen` — whose
 * fragments were written precisely to cover the psychologist/identity-document
 * call — never rendered at all.
 */
describe("processing phase reaches clients before the identity document lands", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let llm: GatedLLM;
  let repo: InMemoryGameRepository;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    llm = new GatedLLM();
    repo = new InMemoryGameRepository();
    // Scene 1 plus one for the end-of-scene prefetch, so the prefetch is a
    // normal success rather than an error path incidental to this test.
    llm.events = [mockEvent(1), mockEvent(2)];
    built = buildServer({
      llm,
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

  it("broadcasts processing to both parents while the psychologist call is still in flight", async () => {
    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Wren" });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await joined2;

    await openFirstScene(p1, p2);

    // Both clients must see it — STATE is per-slot, so a fix that only
    // answered the socket that pressed the button would still leave the
    // co-parent staring at a dead screen.
    const processing1 = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "processing");
    const processing2 = p2.waitFor<ViewerState>(E.STATE, (s) => s.phase === "processing");

    // "walk away"
    p1.emit(E.END_CHAT);

    await Promise.all([processing1, processing2]);

    // THE ASSERTION. The identity-document call has started and has NOT
    // returned, and the phase is already on the wire. Broadcasting after the
    // await — the old behaviour — cannot reach this line: `processing1` would
    // never resolve, because by the time the call returns the phase is
    // `debrief`.
    expect(llm.psychStarted).toBe(true);
    expect(llm.psychResolved).toBe(false);

    // …and the phase the clients can see is NOT the phase on disk. `processing`
    // is a live transient: a crash here has to rehydrate as `family_chat`, or
    // the END_CHAT recovery path has nothing left to re-run and the game is
    // stuck in a phase with no exit. Persisting it would look like a tidy-up.
    const persisted = await repo.loadGame(gameId);
    expect(persisted!.phase).not.toBe("processing");
    expect(persisted!.phase).toBe("family_chat");

    const debrief = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
    llm.releasePsychologist();
    await debrief;
    expect(llm.psychResolved).toBe(true);

    // And the ordering is intact in the log the client actually received:
    // family_chat … processing … debrief, in that order.
    const phases = p1.states().map((s) => s.phase);
    expect(phases.indexOf("processing")).toBeGreaterThan(phases.indexOf("family_chat"));
    expect(phases.indexOf("debrief")).toBeGreaterThan(phases.indexOf("processing"));
  });
});
