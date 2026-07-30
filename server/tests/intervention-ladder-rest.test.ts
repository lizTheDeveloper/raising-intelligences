// Drives the real REST routes (routes/game.ts) end to end through the
// intervention ladder: debrief -> consult/therapy/cps_review -> back to
// event_intro (or, on CPS "removal", into the terminal epilogue). Mirrors
// the stable harness in concern-accrual-rest.test.ts (real express via
// buildServer, MockLLMClient, InMemoryGameRepository; only the LLM is
// mocked). Kept out of the socket layer on purpose — see
// dark-play-reroute-rest.test.ts for why REST needs its own coverage.
//
// The ladder is driven scene-by-scene rather than by a fixed scene count:
// selectDueRung fires as soon as a threshold is crossed, so reaching a
// higher rung requires first reaching AND CONCLUDING every lower rung
// (consult, then therapy) along the way. driveOneScene() runs exactly one
// scene (next-event -> message -> end-chat -> end-debrief) and returns the
// phase end-debrief landed on; the test loops, auto-concluding consult/
// therapy as they appear, until the target phase is reached.
//
// Each LLM-triggering call (message/end-chat/therapy-message) uses a FRESH
// synthetic IP: reaching cps_review alone takes ~7 scenes (14 rate-limited
// requests), which would otherwise blow through the app's 10-req/min-per-IP
// llmRateLimit within a single test and surface as a 429 that this harness
// would misread as a routing bug.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { CONSULT_DECAY, THERAPY_DECAY, THERAPY_TURN_CAP } from "../src/game/state-machine.js";

const testEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

let ipSeq = 0;
/** A fresh synthetic source IP for every rate-limited request in this file. */
function freshIp(): string {
  ipSeq++;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

async function drainSSE(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

interface DoneFrame { type: "done"; [k: string]: unknown }
type SSEFrame = { type: "chunk"; text: string } | DoneFrame | { type: "terminated" } | { type: "error"; error: string };

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

describe("intervention ladder — full drive through the real REST routes", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: MockLLMClient;
  let repo: InMemoryGameRepository;

  beforeAll(async () => {
    mock = new MockLLMClient();
    // Generous supply: world_manager events are consumed once per scene
    // (either via the game-creation/end-chat prefetch or a direct
    // startEvent call), and this suite drives up to ~10 scenes per test
    // across 3 tests.
    mock.events = Array.from({ length: 300 }, (_, i) => ({ ...testEvent, eventNumber: i + 1 }));
    mock.kidResponses = Array.from({ length: 300 }, () => "ok");
    repo = new InMemoryGameRepository();
    built = buildServer({ llm: mock, repo, enableEviction: false, allowedOrigin: "*" });
    await new Promise<void>((resolve) => built.httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await built.close();
  });

  async function createGame(): Promise<string> {
    const createRes = await fetch(`${baseUrl}/api/game`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": freshIp() },
      body: JSON.stringify({ childName: "Kai" }),
    });
    const { gameId } = (await createRes.json()) as { gameId: string };
    return gameId;
  }

  async function sendOneMessage(gameId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": freshIp() },
      body: JSON.stringify({ sender: "parent1", content: "hello" }),
    });
    await drainSSE(res);
  }

  async function endChat(gameId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/end-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": freshIp() },
      body: JSON.stringify({}),
    });
    await drainSSE(res);
  }

  async function postJson(path: string, body: unknown = {}): Promise<any> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": freshIp() },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function therapyMessage(gameId: string, content: string): Promise<SSEFrame[]> {
    const res = await fetch(`${baseUrl}/api/game/${gameId}/therapy-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": freshIp() },
      body: JSON.stringify({ content }),
    });
    return readSSE(res);
  }

  /** Run exactly one scene (from event_intro) through to end-debrief and
   * return the phase end-debrief landed the game in. */
  async function driveOneScene(gameId: string): Promise<string> {
    const nextRes = await fetch(`${baseUrl}/api/game/${gameId}/next-event`, {
      method: "POST",
      headers: { "X-Forwarded-For": freshIp() },
    });
    const nextJson = (await nextRes.json()) as { phase: string };
    expect(nextJson.phase).toBe("family_chat");
    await sendOneMessage(gameId);
    await endChat(gameId);
    const debriefJson = (await postJson(`/api/game/${gameId}/end-debrief`)) as { phase: string };
    return debriefJson.phase;
  }

  /** Drive scenes, auto-concluding consult/therapy as they appear, until the
   * target phase is reached (or reported). Bounded so a routing bug fails
   * fast instead of hanging. */
  async function driveUntil(gameId: string, targetPhase: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const phase = await driveOneScene(gameId);
      if (phase === targetPhase) return;
      if (phase === "consult") {
        await postJson(`/api/game/${gameId}/end-consult`);
        continue;
      }
      if (phase === "therapy") {
        await postJson(`/api/game/${gameId}/end-therapy`);
        continue;
      }
      if (phase === "event_intro") continue;
      throw new Error(`Unexpected phase "${phase}" while driving toward "${targetPhase}"`);
    }
    throw new Error(`Never reached phase "${targetPhase}"`);
  }

  it("Test A (consult): debrief routes into consult at CONSULT_THRESHOLD; end-consult decays and returns to event_intro", async () => {
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    const gameId = await createGame();

    await driveUntil(gameId, "consult");

    const loaded = await repo.loadGame(gameId);
    expect(loaded?.phase).toBe("consult");
    expect(loaded?.highestRungFired).toBe(1);
    const concernBeforeAdvance = loaded!.concernLevel;

    const advanceJson = (await postJson(`/api/game/${gameId}/end-consult`)) as { phase: string };
    expect(advanceJson.phase).toBe("event_intro");

    const afterAdvance = await repo.loadGame(gameId);
    expect(afterAdvance?.phase).toBe("event_intro");
    expect(afterAdvance?.concernLevel).toBe(Math.max(0, concernBeforeAdvance - CONSULT_DECAY));
  });

  it("Test B (therapy): debrief routes into therapy at THERAPY_THRESHOLD (rung 1 already fired); therapy-message + cap + end-therapy", async () => {
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    const gameId = await createGame();

    await driveUntil(gameId, "therapy");

    let loaded = await repo.loadGame(gameId);
    expect(loaded?.phase).toBe("therapy");
    expect(loaded?.highestRungFired).toBe(2);
    expect(loaded?.therapyMessages).toHaveLength(1);
    expect(loaded?.therapyMessages[0].speaker).toBe("therapist");
    const concernBeforeAdvance = loaded!.concernLevel;

    // One therapy turn: parent + therapist reply appended.
    const turnFrames = await therapyMessage(gameId, "I want to do better");
    expect(turnFrames.some((f) => f.type === "error")).toBe(false);
    loaded = await repo.loadGame(gameId);
    expect(loaded?.therapyMessages).toHaveLength(3);
    expect(loaded?.therapyMessages[1].speaker).toBe("parent");
    expect(loaded?.therapyMessages[2].speaker).toBe("therapist");

    // Exhaust the remaining cap (already used 1 of THERAPY_TURN_CAP parent turns).
    for (let i = 1; i < THERAPY_TURN_CAP; i++) {
      const frames = await therapyMessage(gameId, `turn ${i}`);
      expect(frames.some((f) => f.type === "error")).toBe(false);
    }
    loaded = await repo.loadGame(gameId);
    const parentTurns = loaded!.therapyMessages.filter((m) => m.speaker === "parent").length;
    expect(parentTurns).toBe(THERAPY_TURN_CAP);

    // One more turn past the cap must be rejected — no new turns appended.
    const overCapFrames = await therapyMessage(gameId, "one more");
    expect(overCapFrames.some((f) => f.type === "error")).toBe(true);
    const afterOverCap = await repo.loadGame(gameId);
    expect(afterOverCap?.therapyMessages.filter((m) => m.speaker === "parent").length).toBe(THERAPY_TURN_CAP);

    // Conclude: decays by THERAPY_DECAY, returns to event_intro, clears therapyMessages.
    const advanceJson = (await postJson(`/api/game/${gameId}/end-therapy`)) as { phase: string };
    expect(advanceJson.phase).toBe("event_intro");
    const afterAdvance = await repo.loadGame(gameId);
    expect(afterAdvance?.phase).toBe("event_intro");
    expect(afterAdvance?.concernLevel).toBe(Math.max(0, concernBeforeAdvance - THERAPY_DECAY));
    expect(afterAdvance?.therapyMessages).toHaveLength(0);
  });

  it("Test C (removal): CPS review forced to 'removal' at CPS_THRESHOLD; end-cps enters the terminal epilogue without banning", async () => {
    mock.groomingResult = { tier: "concern", reason: "facilitated the child's cruelty" };
    mock.cpsResult = { outcome: "removal", determination: "The department has determined removal is necessary." };
    const gameId = await createGame();

    await driveUntil(gameId, "cps_review");

    const loaded = await repo.loadGame(gameId);
    expect(loaded?.phase).toBe("cps_review");
    expect(loaded?.cpsOutcome).toBe("removal");
    expect(loaded?.highestRungFired).toBe(3);

    const advanceJson = (await postJson(`/api/game/${gameId}/end-cps`)) as { phase: string; epilogue?: string };
    expect(advanceJson.phase).toBe("epilogue");
    expect(advanceJson.epilogue).toBeTruthy();

    const afterAdvance = await repo.loadGame(gameId);
    expect(afterAdvance?.phase).toBe("epilogue");
    expect(afterAdvance?.cpsOutcome).toBe("removal");
    // No IP used anywhere in this drive was ever banned — the removal path
    // must never call repo.banIp (it's an in-fiction outcome, not a ban).
    expect((repo as unknown as { bannedIps: Set<string> }).bannedIps.size).toBe(0);
  });
});
