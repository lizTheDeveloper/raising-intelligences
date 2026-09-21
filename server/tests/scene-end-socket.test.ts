// Companion to scene-end-rest.test.ts: the multiplayer socket path always had
// the auto-end (MUL-59's solo/REST gap is covered by the other suite), but two
// behaviours were never pinned by a test and one was broken in practice:
//
//  1. The old per-chunk scrub `chunk.replace(/\[SCENE_END\]/g, "")` leaks the
//     token whenever the provider splits it across chunks. MockLLMClient
//     streams character-by-character, so this suite only passes with the
//     boundary-safe SceneEndStreamFilter.
//  2. The hard-cap auto-end (spec: "Message cap becomes a hard scene limit")
//     had never been exercised — not in the 2026-09-21 playtest (budget), and
//     not in CI. This is the "confirm it works while you're in there" ask.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { TestClient, connect, openFirstScene } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import { PARENT_MESSAGE_CAP } from "../src/game/state-machine.js";
import type { GameEvent } from "../src/types.js";

function mockEvent(n: number): GameEvent {
  return { eventNumber: n, age: 4, description: `Scene ${n}.`, setting: "Home", trigger: "T" };
}

describe("socket scene auto-end — sentinel stream hygiene and the hard cap", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new MockLLMClient();
    mock.events = Array.from({ length: 20 }, (_, i) => mockEvent(i + 1));
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

  async function twoPlayersInScene1(): Promise<{ p1: TestClient; p2: TestClient; state: ViewerState }> {
    const p1 = await connect(baseUrl);
    const joined = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Wren" });
    const { gameId } = await joined;
    const p2 = await connect(baseUrl);
    p2.emit(E.JOIN_GAME, { gameId });
    await p2.once(E.JOINED);
    clients.push(p1, p2);
    const scene = await openFirstScene(p1, p2);
    // openFirstScene resolves on P1's family_chat STATE; P2 can still have
    // stale (pre-scene) STATE frames queued. Drain P2 to family_chat before
    // any test registers "the scene ended" waiters, or a queued
    // event_intro/old broadcast satisfies them early.
    if (p2.lastState?.phase !== "family_chat") {
      await p2.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat", 10_000);
    }
    return { p1, p2, state: scene };
  }

  it("never shows the player the token, strips it from state, and auto-ends the scene", async () => {
    const { p1, p2 } = await twoPlayersInScene1();
    mock.kidResponses = ["Okay, mom. He reaches for your hand. [SCENE_END]"];

    const sceneEnded = p2.waitFor(E.SCENE_ENDED, () => true, 10_000);
    // Wait for the scene to actually leave family_chat end-to-end (endChat
    // runs processing -> debrief inside this same request).
    const leftFamilyChat = p2.waitFor<ViewerState>(
      E.STATE,
      (s) => s.phase !== "family_chat",
      15_000
    );
    p1.emit(E.PARENT_MESSAGE, { content: "We can hold hands the whole way." });

    await sceneEnded;
    const final = await leftFamilyChat;
    expect(["processing", "debrief"]).toContain(final.phase);

    // Char-by-char mock streaming means any per-chunk regex replace would
    // have leaked the token verbatim into KID_CHUNK.
    expect(p2.kidStream.trim()).toBe("Okay, mom. He reaches for your hand.");
    expect(p2.kidStream).not.toContain("[SCENE_END]");

    // The final broadcast state carries the clean kid line.
    const lastKid = [...(final.messages ?? [])].reverse().find((m) => m.sender === "kid");
    expect(lastKid?.content).toBe("Okay, mom. He reaches for your hand.");
  });

  it("hard-ends the scene when the parent message cap is reached, even with no sentinel", async () => {
    const { p1, p2 } = await twoPlayersInScene1();
    // Neutral reply: no token, and text the closing-action heuristic cannot
    // match — the ONLY thing allowed to end this scene is the cap.
    mock.kidResponses = ["I don't want to talk about it."];

    let sceneEndedFired = false;
    p2.socket.on(E.SCENE_ENDED, () => (sceneEndedFired = true));
    // Registered BEFORE the final send: with a mocked LLM the whole
    // endChat (processing -> debrief) can complete while the loop is still
    // awaiting its last MESSAGE_DONE.
    const leftFamilyChat = p2.waitFor<ViewerState>(
      E.STATE,
      (s) => s.phase === "debrief" || s.phase === "processing",
      15_000
    );

    // Send up to the cap. Nothing may auto-end before the final message.
    for (let i = 0; i < PARENT_MESSAGE_CAP; i++) {
      const done = p2.waitFor(E.MESSAGE_DONE, () => true, 10_000);
      p1.emit(E.PARENT_MESSAGE, { content: `turn ${i + 1}` });
      await done;
      if (i < PARENT_MESSAGE_CAP - 1) {
        expect(sceneEndedFired).toBe(false);
      }
    }

    // Give the cap-triggered emit a beat to land, then assert the end state.
    await new Promise((r) => setTimeout(r, 250));
    expect(sceneEndedFired).toBe(true);

    const final = await leftFamilyChat;
    expect(["processing", "debrief"]).toContain(final.phase);
  }, 30_000);
});
