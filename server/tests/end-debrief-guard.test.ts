import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";

/**
 * `POST /game/:id/end-debrief` used to call `endDebrief(state)` with no phase
 * guard and no game lock, so a double-submit or a stale client retry threw
 * "Invalid transition: END_DEBRIEF from phase <x>" out of the reducer and
 * surfaced as an opaque 500. Two such errors reached GlitchTip on 2026-07-29
 * (from phases `event_intro` and `epilogue`).
 *
 * The route must instead reject the out-of-phase call cleanly and leave the
 * game untouched.
 */
describe("end-debrief phase guard", () => {
  let built: BuiltServer;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    const mock = new MockLLMClient();
    // Game creation eagerly prefetches the next scenario; keep the well full so
    // that unrelated prefetching can't fail these assertions.
    mock.events = Array.from({ length: 12 }, (_, i) => ({
      eventNumber: i + 1,
      age: 3,
      description: `Scenario ${i + 1}.`,
      setting: "Home",
      trigger: "Test",
    }));
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
    await built.close();
  });

  async function newGame(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/game`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ childName: "Guard" }),
    });
    const json = (await res.json()) as { gameId: string };
    return json.gameId;
  }

  it("rejects end-debrief when the game is not in the debrief phase", async () => {
    const gameId = await newGame();

    // A fresh game is in `event_intro`, never `debrief`.
    const res = await fetch(`${baseUrl}/api/game/${gameId}/end-debrief`, { method: "POST" });

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBeTruthy();
    // Must not leak the reducer's internal transition wording.
    expect(json.error).not.toContain("Invalid transition");
  });

  it("leaves the game's phase unchanged after a rejected end-debrief", async () => {
    const gameId = await newGame();

    const before = await fetch(`${baseUrl}/api/game/${gameId}/state`).then((r) => r.json());
    await fetch(`${baseUrl}/api/game/${gameId}/end-debrief`, { method: "POST" });
    const after = await fetch(`${baseUrl}/api/game/${gameId}/state`).then((r) => r.json());

    expect((after as { phase: string }).phase).toBe((before as { phase: string }).phase);
  });

  it("returns 404 for an unknown game rather than throwing", async () => {
    const res = await fetch(
      `${baseUrl}/api/game/00000000-0000-0000-0000-000000000000/end-debrief`,
      { method: "POST" }
    );
    expect(res.status).toBe(404);
  });
});
