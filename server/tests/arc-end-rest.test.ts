// The solo/REST arc backstop: /next-event must refuse to author a scene past
// `totalEvents`, and the game must still be able to reach its epilogue.
//
// Background — the live bug this covers. The solo path generated
// unconditionally and trusted the client to stop at the arc's end (see the
// contract described at routes/game.ts's /end-debrief comment). SoloGame never
// honoured it, so games ran past their arc: game e8af0dc1 reached event 28 of
// 10, at which point the world manager's faithful one-year-per-scene aging
// produced age 31 and validateGameEvent (conversation-engine.ts, rejects
// age > 30) threw on every call — a permanent brick, four next_event_error
// failures in four minutes, with no way forward.
//
// The rule enforced here is the one the multiplayer socket path already had in
// the `debrief` branch of its READY handler (socket/handlers.ts:
// `state.currentEventNumber >= state.totalEvents` -> generateEpilogue). This
// suite is the REST mirror of it.
//
// States are seeded straight into the shared `games` map (BuiltServer.games,
// which resolveGame reads first) rather than driven through ten real scenes:
// the states under test are end-of-arc and past-end-of-arc, and constructing
// them directly is what makes the production state — currentEventNumber 28 of
// 10 with the next age at 31 — reproducible at all.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";
import type { GameEvent, GameState } from "../src/types.js";

let ipSeq = 0;
/** A fresh synthetic source IP per rate-limited request (/epilogue is one). */
function freshIp(): string {
  ipSeq++;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

function playedEvent(n: number): GameEvent {
  return {
    eventNumber: n,
    age: n + 2,
    description: `Scene ${n}.`,
    setting: "Home",
    trigger: "Something happened",
  };
}

interface SSEFrame {
  type: string;
  [k: string]: unknown;
}

async function readSSE(res: Response): Promise<SSEFrame[]> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SSEFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.replace(/^data:\s*/, "").trim();
      if (line) frames.push(JSON.parse(line) as SSEFrame);
    }
  }
  return frames;
}

describe("solo arc end — /next-event backstop and epilogue recovery", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  let repo: InMemoryGameRepository;

  beforeAll(async () => {
    mock = new MockLLMClient();
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await built.close();
  });

  /**
   * Seed a solo game mid-flight at a given point in its arc. `eventNumber`
   * events are treated as already played, and the game sits in `event_intro`
   * with no current event — the exact state the client's next `/next-event`
   * call is made from.
   */
  function seedGame(eventNumber: number): GameState {
    const base = createGame("Wren", "solo parent");
    const state: GameState = {
      ...base,
      phase: "event_intro",
      currentEvent: null,
      currentEventNumber: eventNumber,
      events: Array.from({ length: eventNumber }, (_, i) => playedEvent(i + 1)),
      identityDocument: "Core beliefs: the world is mostly safe.",
    };
    built.games.set(state.id, state);
    return state;
  }

  async function postNextEvent(gameId: string) {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/next-event`, {
      method: "POST",
      headers: { "X-Forwarded-For": freshIp() },
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function postEpilogue(gameId: string) {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/epilogue`, {
      method: "POST",
      headers: { "X-Forwarded-For": freshIp() },
    });
    return readSSE(res);
  }

  it("at exactly totalEvents: refuses to generate, and the epilogue is reachable", async () => {
    const state = seedGame(10);
    expect(state.totalEvents).toBe(10);

    // A perfectly valid scene 11 is waiting in the queue. The point of the
    // assertions below is that it is never asked for — a route that generates
    // here would happily return it, which is exactly the bug.
    mock.events = [{ eventNumber: 11, age: 13, description: "Scene 11.", setting: "Home", trigger: "x" }];
    const rolesBefore = mock.roleCalls.length;

    const { status, json } = await postNextEvent(state.id);

    expect(status).toBe(200);
    expect(json.storyComplete).toBe(true);
    expect(json.event).toBeNull();
    // DISCRIMINATOR: no world-manager call, and the queued scene is untouched.
    // Removing the guard in routes/game.ts makes all four of these fail.
    expect(mock.roleCalls.slice(rolesBefore)).not.toContain("world_manager");
    expect(mock.events).toHaveLength(1);
    // The arc did not advance — no scene 11 exists, and no one aged.
    expect(built.games.get(state.id)!.currentEventNumber).toBe(10);

    // ...and the player can still finish their story.
    const frames = await postEpilogue(state.id);
    const done = frames.find((f) => f.type === "done");
    expect(done?.phase).toBe("epilogue");
    expect(built.games.get(state.id)!.phase).toBe("epilogue");
  });

  it("already past totalEvents (the production state): recovers instead of erroring", async () => {
    // Game e8af0dc1's live state: event 28 of a 10-event arc. The next scene
    // the world manager produces for it is age 31.
    const state = seedGame(28);
    expect(state.events[state.events.length - 1]!.age).toBe(30);

    // The scene that bricked the real game: validateGameEvent rejects age > 30,
    // so generating here throws and the route 500s with no way forward.
    mock.events = [{ eventNumber: 29, age: 31, description: "Scene 29.", setting: "Home", trigger: "x" }];
    const rolesBefore = mock.roleCalls.length;

    const { status, json } = await postNextEvent(state.id);

    // DISCRIMINATOR: without the guard this is a 500 (`next_event_error`),
    // which is precisely what the player saw four times in four minutes.
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.storyComplete).toBe(true);
    expect(json.event).toBeNull();
    expect(mock.roleCalls.slice(rolesBefore)).not.toContain("world_manager");
    expect(mock.events).toHaveLength(1);

    // Recovery: the over-cap game reaches its epilogue rather than erroring
    // forever. No data edit — the same `>=` guard that stops generation is
    // what lets every already-broken game self-heal through this door.
    const frames = await postEpilogue(state.id);
    const done = frames.find((f) => f.type === "done");
    expect(done?.phase).toBe("epilogue");
    expect(typeof done?.epilogue).toBe("string");
    expect(built.games.get(state.id)!.phase).toBe("epilogue");
  });

  it("mid-arc: the manual early exit still reaches the epilogue", async () => {
    // What the "end childhood → epilogue" button does — from the debrief, well
    // short of the arc's end. NOTE: this test does not exercise the
    // /next-event guard, so disabling that guard does not fail it; it
    // discriminates against a backstop applied to /epilogue (i.e. a fix that
    // ended the story by refusing the early exit too). The button's own
    // wiring in SoloGame.tsx is typecheck-only — this repo has no client test
    // runner.
    const state = seedGame(3);
    built.games.set(state.id, { ...state, phase: "debrief" });

    const frames = await postEpilogue(state.id);
    const done = frames.find((f) => f.type === "done");
    expect(done?.phase).toBe("epilogue");
    expect(built.games.get(state.id)!.phase).toBe("epilogue");
    expect(built.games.get(state.id)!.currentEventNumber).toBe(3);
  });

  it("mid-arc: /next-event still generates normally under the cap", async () => {
    // Non-regression, and the discriminator against an over-broad guard: the
    // backstop must fire at the end of the arc and nowhere else.
    const state = seedGame(4);
    mock.events = [{ eventNumber: 5, age: 7, description: "Scene 5.", setting: "Home", trigger: "x" }];

    const { status, json } = await postNextEvent(state.id);

    expect(status).toBe(200);
    expect(json.storyComplete).toBeUndefined();
    expect(json.event).toMatchObject({ age: 7, description: "Scene 5." });
    expect(built.games.get(state.id)!.currentEventNumber).toBe(5);
  });
});
