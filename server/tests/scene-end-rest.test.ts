// Regression for MUL-59: in the 2026-09-21 production playtest, no solo scene
// ever auto-ended (3/3 resolved scenes, 9/9 kid replies). The cause: natural
// scene resolution — [SCENE_END] detection, sentinel stripping, and the
// hard-cap end — was implemented only in the multiplayer socket PARENT_MESSAGE
// handler. Solo play is REST (POST /game/:id/message), and that route had none
// of it: the sentinel would have been streamed and persisted raw, and scenes
// ended only when the player clicked "end conversation".
//
// This suite pins the solo path to the shared scene-end module (server/src/
// game/scene-end.ts): the done frame must carry the auto-end signal, nothing
// reaching the player or the database may contain the token, and the cap must
// hard-end the scene.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { PARENT_MESSAGE_CAP, createGame, transition } from "../src/game/state-machine.js";
import type { GameState } from "../src/types.js";

const testEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They refuse the bath.",
  setting: "Bathroom",
  trigger: "Bath standoff",
};

interface SSEFrame {
  type: string;
  kidResponse?: string;
  messagesRemaining?: number;
  sceneEnded?: boolean;
  autoEnd?: boolean;
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

describe("solo REST scene-end — detection, stripping, auto-end (MUL-59)", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  let repo: InMemoryGameRepository;
  let ipSeq = 0;
  const freshIp = () => `10.9.${(ipSeq >> 8) & 255}.${++ipSeq & 255}`;

  beforeAll(async () => {
    mock = new MockLLMClient();
    mock.events = Array.from({ length: 12 }, (_, i) => ({ ...testEvent, eventNumber: i + 1 }));
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await built.close();
  });

  /** Seed a solo game already sitting in family_chat, with a given history. */
  function seedScene(history: Array<"open" | "closed">): GameState {
    let state = createGame("Juno", "solo parent");
    state = transition(state, { type: "START_EVENT", event: testEvent });
    state = transition(state, { type: "KID_MESSAGE", content: "No! The robot gets wet!" });
    for (const kind of history) {
      state = transition(state, {
        type: "PARENT_MESSAGE",
        sender: "parent1",
        content: `parent turn (${kind})`,
      });
      state = transition(state, {
        type: "KID_MESSAGE",
        content: kind === "open" ? "No! Mine!" : "She walks away.",
      });
    }
    built.games.set(state.id, state);
    return state;
  }

  async function send(gameId: string, content: string): Promise<SSEFrame[]> {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": freshIp() },
      body: JSON.stringify({ sender: "parent1", content }),
    });
    return readSSE(res);
  }

  it("strips the sentinel from the stream and the done frame, and arms the auto-end", async () => {
    mock.kidResponses = ["Deal. I'm taking him to the bath. [SCENE_END]"];
    const state = seedScene(["open"]);

    const frames = await send(state.id, "Bath first, then buttons.");
    const chunks = frames.filter((f) => f.type === "chunk").map((f) => f.text as string);
    const done = frames.find((f) => f.type === "done")!;

    // MockLLMClient streams one character at a time — the token can only be
    // kept out of the wire by the boundary-safe filter, not a per-chunk regex.
    // (The space that preceded the token is streamed; the saved/payload text
    // is trimmed by stripSceneEnd.)
    expect(chunks.join("").trim()).toBe("Deal. I'm taking him to the bath.");
    expect(done.kidResponse).toBe("Deal. I'm taking him to the bath.");
    expect(done.sceneEnded).toBe(true);
    expect(done.autoEnd).toBe(true);

    // The persisted kid message must be clean too — the sentinel is a wire
    // protocol, not story text.
    const loaded = await repo.loadGame(state.id);
    const kidMsgs = loaded!.messages.filter((m) => m.sender === "kid");
    expect(kidMsgs[kidMsgs.length - 1]!.content).toBe("Deal. I'm taking him to the bath.");
  });

  it("does not arm the auto-end on a mid-scene reply", async () => {
    mock.kidResponses = ["No! His buttons are for ON, not wet!"];
    const state = seedScene([]);

    const frames = await send(state.id, "Juno, bath time.");
    const done = frames.find((f) => f.type === "done")!;
    expect(done.sceneEnded).toBe(false);
    expect(done.autoEnd).toBe(false);
  });

  it("arms the auto-end at the message cap even without any sentinel", async () => {
    mock.kidResponses = ["Okay."];
    const openHistory = Array.from({ length: PARENT_MESSAGE_CAP - 2 }, () => "open" as const);
    const state = seedScene(openHistory);
    expect(state.parentMessageCount).toBe(PARENT_MESSAGE_CAP - 2);

    await send(state.id, "one more");
    const frames = await send(state.id, "and the last one");
    const done = frames.find((f) => f.type === "done")!;
    expect(done.sceneEnded).toBe(false);
    expect(done.autoEnd).toBe(true);
    expect(done.messagesRemaining).toBe(0);
  });

  it("ends a resolved scene via the closing-action heuristic when the model skips the token", async () => {
    mock.kidResponses = ["I'm done. She drops the towel and walks away, upstairs to her room."];
    const state = seedScene(["closed", "closed", "closed"]);

    const frames = await send(state.id, "The towels go in the wash.");
    const done = frames.find((f) => f.type === "done")!;
    expect(done.sceneEnded).toBe(true);
    expect(done.autoEnd).toBe(true);
  });
});
