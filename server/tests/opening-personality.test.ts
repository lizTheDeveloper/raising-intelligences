import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { LLMRole } from "../src/llm/model-config.js";
import { TestClient, connect, OCEAN_P1, OCEAN_P2 } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import type { GameEvent } from "../src/types.js";

/**
 * The content half of the 2026-07-31 opening reorder (docs/playtest-notes.md,
 * item 1).
 *
 * Reordering the guardian quiz ahead of scene 1 was approved not for pacing but
 * because of what it fixes: the personality seed feeds the kid's temperament
 * (context-assembler.ts:140) and is interpolated into the world-manager system
 * prompt (`{personalitySeed}`), but it did not exist until *after* the quiz —
 * which used to run after scene 1 had already been generated. Every game's
 * opening scene was therefore built from `personalitySeed: ""` and an empty
 * `parentPersonalities`: the one scene in the whole game that knew nothing
 * about the people playing it.
 *
 * A passing build cannot show this. Only the prompt can. These tests read what
 * the world manager was actually handed for scene 1.
 */

const SEED_SENTINEL =
  "SEED-SENTINEL: quick to laugh, slow to trust, and already counting the exits.";

const P1_CONFESSIONAL = "P1-CONFESSIONAL I told my sister her hamster ran away.";
const P2_CONFESSIONAL = "P2-CONFESSIONAL I broke a window and blamed the neighbour.";

function mockEvent(n: number): GameEvent {
  return {
    eventNumber: n,
    age: 3,
    description: `Scenario ${n}.`,
    setting: "Home",
    trigger: "Test",
  };
}

/** Records the exact prompts each role was handed. */
class RecordingMock extends MockLLMClient {
  worldManagerPrompts: string[] = [];
  personalitySeedPrompts: string[] = [];

  override async completeJson<T>(system: string, userMessage: string, role?: LLMRole): Promise<T> {
    if (role === "world_manager") this.worldManagerPrompts.push(`${system}\n${userMessage}`);
    return super.completeJson<T>(system, userMessage, role);
  }

  override async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    if (role === "personality_seed") {
      this.personalitySeedPrompts.push(`${system}\n${userMessage}`);
      return SEED_SENTINEL;
    }
    return super.completeResponse(system, userMessage, maxTokens, role, onChunk);
  }
}

describe("Scene 1 is personality-informed", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: RecordingMock;
  let repo: InMemoryGameRepository;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new RecordingMock();
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

  it("hands the world manager the seed and both parents' answers before it builds scene 1", async () => {
    mock.events = [mockEvent(1)];
    mock.worldManagerPrompts = [];
    mock.personalitySeedPrompts = [];

    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Ilse" });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await joined2;

    // Both ready out of the lobby. Nothing may be generated yet: this is the
    // window in which the old code built scene 1.
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(mock.worldManagerPrompts).toHaveLength(0);

    // The guardian quiz.
    const chat = p1.waitFor<ViewerState>(
      E.STATE,
      (s) => s.phase === "family_chat" && s.currentEvent !== null
    );
    p1.emit(E.SUBMIT_PERSONALITY, {
      ocean: OCEAN_P1,
      confessional1: P1_CONFESSIONAL,
      confessional2: "",
    });
    p2.emit(E.SUBMIT_PERSONALITY, {
      ocean: OCEAN_P2,
      confessional1: P2_CONFESSIONAL,
      confessional2: "",
    });
    await chat;

    // The seed was built from BOTH parents — their confessionals are in the
    // prompt that produced it, which is how the second parent reaches scene 1.
    expect(mock.personalitySeedPrompts).toHaveLength(1);
    expect(mock.personalitySeedPrompts[0]).toContain(P1_CONFESSIONAL);
    expect(mock.personalitySeedPrompts[0]).toContain(P2_CONFESSIONAL);

    // And scene 1 — the first and only world-manager call — was handed it.
    expect(mock.worldManagerPrompts).toHaveLength(1);
    expect(mock.worldManagerPrompts[0]).toContain(SEED_SENTINEL);

    // The state scene 1 was generated from, as persisted: non-empty seed, both
    // parent personalities present, and it really is scene 1.
    const saved = await repo.loadGame(gameId);
    expect(saved!.currentEventNumber).toBe(1);
    expect(saved!.personalitySeed).toBe(SEED_SENTINEL);
    expect(saved!.personalitySeed).not.toBe("");
    expect(saved!.parentPersonalities.parent1?.ocean).toEqual(OCEAN_P1);
    expect(saved!.parentPersonalities.parent2?.ocean).toEqual(OCEAN_P2);
    expect(saved!.parentPersonalities.parent1?.confessional1).toBe(P1_CONFESSIONAL);
    expect(saved!.parentPersonalities.parent2?.confessional1).toBe(P2_CONFESSIONAL);
  });

  it("never asks the world manager for scene 1 with an empty temperament", async () => {
    // The precise old failure: `{personalitySeed}` interpolated to nothing, so
    // the prompt read "Your temperament: " / an empty "## Child temperament"
    // section. Asserting the sentinel is present is not the same as asserting
    // the empty rendering is absent — a future regression could pass the seed
    // somewhere harmless and still generate the scene blind.
    for (const prompt of mock.worldManagerPrompts) {
      expect(prompt).not.toMatch(/## Child temperament\s*\n\s*\n\s*The child's temperament/);
    }
    expect(mock.worldManagerPrompts.length).toBeGreaterThan(0);
  });

  /**
   * The guardian screen's waiting step has to name the wait it is in, and
   * between one parent submitting and the other submitting there is no
   * generation happening at all — the seed call cannot start until both answer
   * sets exist. Saying "shaping who they'll become…" there was the one progress
   * message in the opening that was simply false.
   *
   * Carried on STATE rather than left to the one-shot PERSONALITY_SUBMITTED
   * event, for the same reason `generating` is: that event is not replayed on
   * reconnect, so a client that dropped mid-quiz would describe the wrong wait.
   */
  it("tells each parent, on STATE, whether the OTHER one has finished the quiz", async () => {
    mock.events = [mockEvent(1)];

    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Bo" });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId });
    await joined2;

    // Out of the lobby and into the quiz. Neither has answered yet.
    const seen1 = p1.waitFor<ViewerState>(E.STATE);
    const seen2 = p2.waitFor<ViewerState>(E.STATE);
    p1.emit(E.READY, { ready: true });
    p2.emit(E.READY, { ready: true });
    expect((await seen1).partnerPersonalitySubmitted).toBe(false);
    expect((await seen2).partnerPersonalitySubmitted).toBe(false);

    // Parent 1 finishes. It is slot-specific: parent 2 is now the one who has
    // answered *from parent 1's point of view* — and vice versa.
    const afterP1on1 = p1.waitFor<ViewerState>(E.STATE);
    const afterP1on2 = p2.waitFor<ViewerState>(
      E.STATE,
      (s) => s.partnerPersonalitySubmitted === true
    );
    p1.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P1, confessional1: "", confessional2: "" });
    // Parent 1 is still waiting on parent 2 — nothing is generating yet.
    expect((await afterP1on1).partnerPersonalitySubmitted).toBe(false);
    // Parent 2 can see that their co-parent is done.
    await afterP1on2;

    // Both in: the seed runs, scene 1 follows, and each side now reports true.
    const chat = p1.waitFor<ViewerState>(
      E.STATE,
      (s) => s.phase === "family_chat" && s.currentEvent !== null
    );
    p2.emit(E.SUBMIT_PERSONALITY, { ocean: OCEAN_P2, confessional1: "", confessional2: "" });
    const scene = await chat;
    expect(scene.partnerPersonalitySubmitted).toBe(true);
    expect(p2.lastState!.partnerPersonalitySubmitted).toBe(true);
  });
});
