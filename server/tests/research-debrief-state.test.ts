import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { createGame } from "../src/game/state-machine.js";
import type { LLMRole } from "../src/llm/model-config.js";

/**
 * The debrief shows the child's own memory of the scene, taken from
 * GET /state. The Psychologist's identity document is the parent-facing
 * analysis and must never be in that response. Regression test: both halves
 * already held when it was written.
 */
const MEMORY = "I remember the sound of the door and that Mom stayed.";
const IDENTITY = "IDENTITY-DOC-SENTINEL: core beliefs and attachment pattern.";

class RoleMock extends MockLLMClient {
  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    if (role === "memory_summarizer") return MEMORY;
    if (role === "psychologist") {
      this.roleCalls.push(role);
      onChunk?.(IDENTITY);
      return IDENTITY;
    }
    return super.completeResponse(system, userMessage, maxTokens, role, onChunk);
  }
}

describe("debrief state after end-chat", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let repo: InMemoryGameRepository;

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    repo = new InMemoryGameRepository();
    // end-chat prefetches the next scene, which needs one queued event.
    const llm = new RoleMock();
    llm.events = [{ eventNumber: 2, age: 5, description: "Morning.", setting: "yard", trigger: "a lost shoe" }];
    built = buildServer({ llm, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await built.close();
  });

  it("after end-chat, GET /state returns the memory summary and never the identity document", async () => {
    const base = createGame("Wren");
    const state = {
      ...base,
      phase: "family_chat" as const,
      currentEventNumber: 1,
      currentEvent: { eventNumber: 1, age: 4, description: "A quiet evening.", setting: "kitchen", trigger: "spilled milk" },
      messages: [
        { sender: "parent1" as const, content: "Hi Wren", chatType: "family" as const, eventNumber: 1 },
        { sender: "child" as const, content: "Hi", chatType: "family" as const, eventNumber: 1 },
      ],
    };
    await repo.saveGame(state as never);

    const end = await fetch(`${baseUrl}/api/game/${state.id}/end-chat`, { method: "POST" });
    expect(end.status).toBe(200);
    await end.text();

    const res = await fetch(`${baseUrl}/api/game/${state.id}/state`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.phase).toBe("debrief");
    expect(body.memorySummary).toBe(MEMORY);
    expect(body).not.toHaveProperty("identityDocument");
    expect(body).not.toHaveProperty("identitySnapshots");
    expect(raw).not.toContain("IDENTITY-DOC-SENTINEL");
  });
});
