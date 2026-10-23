import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { QUESTION_BANK } from "../src/research/questions.js";

const ABOUT_YOU = "SENTINEL-ABOUT-YOU-ANSWER";
const ABOUT_MOMENT = "SENTINEL-ABOUT-MOMENT-ANSWER";
const REPAIR = "SENTINEL-REPAIR-MESSAGE";
const CONFESSIONAL = "SENTINEL-CONFESSIONAL-TEXT";
const EMAIL = "sentinel.parent@example.org";
const SENTINELS = [ABOUT_YOU, ABOUT_MOMENT, REPAIR, EMAIL, "sentinel.parent"];
// Server-side fields that must never reach a /state body.
const INTERNAL_KEYS = ["parentContext", "repairNote", "sceneRepairLine", "identityDocument", "parentPersonalities"];

describe("GET /state on an adult research game never carries research data", () => {
  let built: BuiltServer;
  let baseUrl: string;
  const saved = process.env.RI_RESEARCH_ENABLED;

  beforeAll(async () => {
    process.env.RI_RESEARCH_ENABLED = "true";
    process.env.DISABLE_PORTRAITS = "1";
    const mock = new MockLLMClient();
    mock.events = Array.from({ length: 5 }, (_, i) => ({ eventNumber: i + 1, age: 4, description: `Scenario ${i + 1}.`, setting: "Home", trigger: "Test" }));
    built = buildServer({ llm: mock, repo: new InMemoryGameRepository(), enableEviction: false, allowedOrigin: "*", socketPath: "/socket.io" });
    await new Promise<void>((r) => built.httpServer.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(built.httpServer.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    await built.close();
    if (saved === undefined) delete process.env.RI_RESEARCH_ENABLED; else process.env.RI_RESEARCH_ENABLED = saved;
  });

  let ip = 0;
  const call = (method: string, path: string, body?: unknown, secret?: string) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${++ip}`, ...(secret ? { "x-game-secret": secret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("state and questions bodies contain no answer, repair, contact or internal field", async () => {
    const created = await (await call("POST", "/game", { childName: "Kai", relationshipType: "solo parent", birthYear: new Date().getFullYear() - 40 })).json() as { gameId: string; secret: string };
    const { gameId, secret } = created;
    const aboutYou = QUESTION_BANK.find((q) => q.kind === "about_you" && q.answer.type === "text")!;
    const aboutMoment = QUESTION_BANK.find((q) => q.kind === "about_moment")!;

    expect((await call("POST", `/game/${gameId}/personality`, { ocean: [3, 3, 3, 3, 3], confessional1: CONFESSIONAL, slot: "parent1" }, secret)).status).toBe(200);
    expect((await call("POST", `/game/${gameId}/next-event`, {}, secret)).status).toBe(200);
    const ans = (q: typeof aboutYou, answer: string) =>
      call("POST", `/game/${gameId}/answers`, { questionId: q.id, version: q.version, sceneIndex: 1, answer, shownAt: Date.now() }, secret);
    expect((await ans(aboutYou, ABOUT_YOU)).status).toBe(204);
    expect((await ans(aboutMoment, ABOUT_MOMENT)).status).toBe(204);
    await (await call("POST", `/game/${gameId}/end-chat`, {}, secret)).text();
    expect((await call("POST", `/game/${gameId}/repair`, { message: REPAIR }, secret)).status).toBe(204);
    expect((await call("POST", `/research/followup/${gameId}`, { email: EMAIL, consentFollowup: true, consentAiAnalysis: true }, secret)).status).toBe(204);

    const bodies: Record<string, string> = {};
    bodies.state = await (await call("GET", `/game/${gameId}/state`)).text();
    bodies.stateWithSecret = await (await call("GET", `/game/${gameId}/state`, undefined, secret)).text();
    for (const wait of ["first", "post_scene", "next_scene"]) {
      const r = await call("GET", `/game/${gameId}/questions?wait=${wait}`, undefined, secret);
      expect(r.status).toBe(200);
      bodies[`questions:${wait}`] = await r.text();
    }
    expect(JSON.parse(bodies.state).phase).toBeTruthy(); // a real state body, not an error
    for (const [name, text] of Object.entries(bodies)) {
      for (const s of SENTINELS) expect(text, `${name} leaks ${s}`).not.toContain(s);
      if (name.startsWith("state")) {
        for (const k of INTERNAL_KEYS) expect(text, `${name} exposes ${k}`).not.toContain(`"${k}"`);
        expect(text, `${name} leaks the confessional`).not.toContain(CONFESSIONAL);
      }
    }
  });
});
