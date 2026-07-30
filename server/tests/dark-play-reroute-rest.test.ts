import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";

const testEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

interface DoneFrame {
  type: "done";
  kidResponse: string;
  messagesRemaining: number;
}
type MessageFrame =
  | { type: "chunk"; text: string }
  | DoneFrame
  | { type: "terminated" }
  | { type: "error"; error: string };

async function readSSE(res: Response): Promise<MessageFrame[]> {
  if (!res.body) throw new Error("No response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: MessageFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.replace(/^data:\s*/, "").trim();
      if (line) frames.push(JSON.parse(line) as MessageFrame);
    }
  }
  return frames;
}

/**
 * Drives the actual REST routing in server/src/routes/game.ts — a SECOND,
 * independent implementation of the same tier -> side-effect dispatch used
 * by the socket handlers (see dark-play-reroute.test.ts for that path). The
 * Plan 1 implementation report flagged this file as an omission the original
 * plan missed; a miswire here would NOT be caught by the socket-layer test,
 * so it needs its own routing-layer coverage. Real express app + real routes
 * + real ConversationEngine; only the LLM is mocked.
 */
describe("dark-play reroute (routing layer, via real REST routes)", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  let repo: InMemoryGameRepository;

  beforeAll(async () => {
    mock = new MockLLMClient();
    // One event is consumed (via prefetchNextEvent's "world_manager" call) per
    // game created below; two tests -> two games -> two events needed.
    mock.events = [testEvent, { ...testEvent, eventNumber: 2 }];
    mock.kidResponses = ["ok"];
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = built.httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await built.close();
  });

  async function createGameAndReachFamilyChat(ip: string): Promise<string> {
    const createRes = await fetch(`${baseUrl}/api/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ childName: "Kai" }),
    });
    const { gameId } = (await createRes.json()) as { gameId: string };

    const nextRes = await fetch(`${baseUrl}/api/game/${gameId}/next-event`, {
      method: "POST",
      headers: { "X-Forwarded-For": ip },
    });
    const nextJson = (await nextRes.json()) as { phase: string };
    expect(nextJson.phase).toBe("family_chat");
    return gameId;
  }

  async function sendMessage(gameId: string, ip: string, content: string): Promise<MessageFrame[]> {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ sender: "parent1", content }),
    });
    return readSSE(res);
  }

  it("concern verdict: routes through recordConcern — session continues, IP not banned, kid's turn still delivered", async () => {
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    const ip = "61.61.61.1";
    const gameId = await createGameAndReachFamilyChat(ip);

    // 4 messages trip the mid-scene checkpoint (MID_SCENE_ABUSE_CHECK_EVERY).
    let lastFrames: MessageFrame[] = [];
    for (let i = 1; i <= 4; i++) {
      lastFrames = await sendMessage(gameId, ip, `message ${i}`);
    }

    // (d) the child's turn was still delivered — the request completed
    // normally (a "done" frame with the kid's reply), not terminated.
    const done = lastFrames.find((f): f is DoneFrame => f.type === "done");
    expect(done).toBeDefined();
    expect(done!.kidResponse).toBe("ok");
    expect(lastFrames.some((f) => f.type === "terminated")).toBe(false);

    const stateRes = await fetch(`${baseUrl}/api/game/${gameId}/state`);
    const state = (await stateRes.json()) as { phase: string };
    expect(state.phase).not.toBe("ended"); // (b)
    expect(await repo.isIpBanned(ip)).toBe(false); // (a)
    expect(await repo.loadConcernEvents(gameId)).not.toHaveLength(0); // (c)
  });

  it("block verdict: routes through applyModerationBlock — session ends and IP is banned", async () => {
    mock.groomingResult = { tier: "block", reason: "sexual content directed at the child" };
    const ip = "61.61.61.2";
    const gameId = await createGameAndReachFamilyChat(ip);

    for (let i = 1; i <= 3; i++) {
      await sendMessage(gameId, ip, `message ${i}`);
    }
    // The 4th message trips the checkpoint: terminates instead of completing normally.
    const lastFrames = await sendMessage(gameId, ip, "message 4");

    expect(lastFrames.some((f) => f.type === "terminated")).toBe(true);
    expect(lastFrames.some((f) => f.type === "done")).toBe(false);

    const stateRes = await fetch(`${baseUrl}/api/game/${gameId}/state`);
    const state = (await stateRes.json()) as { phase: string };
    expect(state.phase).toBe("ended");
    expect(await repo.isIpBanned(ip)).toBe(true);
    // A "block" verdict must never also record a concern_events row.
    expect(await repo.loadConcernEvents(gameId)).toHaveLength(0);
  });
});
