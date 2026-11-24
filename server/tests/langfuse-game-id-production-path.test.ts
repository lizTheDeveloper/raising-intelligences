import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HostHarness } from "./helpers/host-tools.js";
import { LangfuseSink, type SinkTrace } from "./helpers/langfuse-sink.js";
import { openFirstScene, type TestClient } from "./helpers/socket-client.js";
import { RestClient } from "./helpers/rest-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import { TracedLLMClient, traceAppLlm, flushLangfuse, __resetLangfuseClientForTests } from "../src/observability/langfuse.js";
import {
  HOSTED_NO_ANALYSIS_TAG,
  __resetHostedGamesForTests,
  fetchHostedTraces,
  hostedTraceIdsToDrop,
} from "../src/observability/hosted-analysis.js";
import { CHILD_SAFETY_HOLD_TAG, fetchHeldTraceIds, filterHeldTraces } from "../src/observability/child-safety-exclusion.js";
import { logger } from "../src/logger.js";
import { CONSULT_THRESHOLD, THERAPY_THRESHOLD, CPS_THRESHOLD } from "../src/game/state-machine.js";

/**
 * Every Langfuse trace of a game carries that game's id, through the path
 * production actually takes: the app's single traced client (index.ts), the
 * real socket and REST handlers, the real engines, the real `langfuse` SDK,
 * and a Langfuse stand-in over HTTP (helpers/langfuse-sink.ts). Only the model
 * is canned.
 *
 * Before 2.12.2 no trace carried a game id: index.ts built one
 * TracedLLMClient with empty metadata and nothing scoped it to a game, so
 * `hosted_no_analysis` (H18) and `child_safety_hold` were never on a trace and
 * every reader that filters on them dropped nothing. The 2.12.0 test built
 * `new TracedLLMClient(inner, { gameId })` itself, a path production never
 * took, which is why it was green.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sink = new LangfuseSink();
const errors: Array<{ msg: string; fields?: Record<string, unknown> }> = [];

/** Exactly how index.ts wraps the app's model client. */
const production = (inner: import("../src/llm/client.js").LLMClient) => traceAppLlm(inner, "standard");

const roleOf = (t: SinkTrace) => t.tags.find((x) => x.startsWith("llm_role:"))?.slice("llm_role:".length);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for fire-and-forget model calls (scene prefetch, moment labels, the hold) to finish, then flushes the SDK. */
async function settle(h: HostHarness): Promise<void> {
  let last = -1;
  for (let still = 0; still < 4; ) {
    await sleep(40);
    const n = h.mock.roleCalls.length;
    still = n === last ? still + 1 : 0;
    last = n;
  }
  await flushLangfuse();
}

async function say(client: TestClient, content: string, observers: TestClient[]): Promise<void> {
  const dones = observers.map((o) => o.once(E.MESSAGE_DONE));
  client.emit(E.PARENT_MESSAGE, { content });
  await Promise.all(dones);
}

const CONFESSIONAL_WORDS = ["hamster", "forged the report card", "blamed the neighbour", "chess club"];

/** Plays a seated pair from the lobby through one scene (shared chat, a sidebar, the debrief) to the report card, with an adult conversation on the way when asked. */
async function playToReportCard(A: TestClient, B: TestClient, opts: { adultChat?: boolean } = {}): Promise<void> {
  await openFirstScene(A, B);
  await say(A, "Hey kiddo, how was school?", [A, B]);
  await say(B, "We're proud of you, you know.", [A, B]);
  const sidebar = A.waitFor<ViewerState>(E.STATE, (s) => s.phase === "sidebar");
  A.emit(E.START_SIDEBAR);
  await sidebar;
  await say(A, "Just between us, are you okay?", [A]);
  const back = A.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
  A.emit(E.END_SIDEBAR);
  await back;
  const debrief = A.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
  A.emit(E.END_CHAT);
  await debrief;
  const epilogue = A.once<{ epilogue: string }>(E.EPILOGUE);
  A.emit(E.START_EPILOGUE);
  const ep = await epilogue;
  if (opts.adultChat) {
    const adult = A.waitFor<ViewerState>(E.STATE, (s) => s.phase === "adult_chat");
    A.emit(E.ADULT_CHAT, { scenario: "Your grown child calls on a Sunday." });
    await adult;
    await say(A, "How's the new job?", [A, B]);
  }
  const report = A.once(E.REPORT_CARD_READY);
  A.emit(E.REPORT_CARD, { epilogue: ep.epilogue });
  await report;
}

describe("Langfuse traces carry the game id on the production path", () => {
  let h: HostHarness;

  beforeAll(async () => {
    await sink.start();
  });
  afterAll(async () => {
    await sink.stop();
  });

  beforeEach(async () => {
    sink.clear();
    sink.use();
    __resetLangfuseClientForTests();
    __resetHostedGamesForTests();
    errors.length = 0;
    vi.spyOn(logger, "error").mockImplementation((msg, fields) => void errors.push({ msg, fields }));
    h = new HostHarness({ wrapLlm: production });
    h.mock.events = h.events(40);
    await h.boot();
  });

  afterEach(async () => {
    await h.close();
    await flushLangfuse();
    __resetLangfuseClientForTests();
    sink.restore();
    vi.restoreAllMocks();
  });

  it("a meetup game: every call is traced, every trace has game_id and hosted_no_analysis, and the readers drop them all", async () => {
    const ev = await h.event({ kind: "studio", level: 0, name: "tuesday tea" });
    const p = await h.pair(ev.code);
    await playToReportCard(p.A, p.B);
    await settle(h);

    const traces = [...sink.traces.values()];
    // One trace per model call: none went untraced, none was dropped.
    expect(traces.length).toBe(h.mock.roleCalls.length);
    const roles = new Set(traces.map(roleOf));
    for (const role of ["personality_seed", "world_manager", "kid_family_chat", "kid_sidebar", "psychologist", "epilogue", "report_card"]) {
      expect(roles, `a ${role} trace`).toContain(role);
    }
    for (const t of traces) {
      expect(t.tags, `${t.name}`).toContain(`game_id:${p.gameId}`);
      expect(t.tags, `${t.name}`).toContain(HOSTED_NO_ANALYSIS_TAG);
    }

    // The readers (scripts/model-search.ts, the ri-devlog skill) query
    // ?tags=hosted_no_analysis and drop what isn't allow-listed: here, all of it.
    const get = async (path: string, params: Record<string, string> = {}) => {
      const url = new URL(path, sink.url);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return (await fetch(url)).json();
    };
    const hosted = await fetchHostedTraces(get);
    expect(hosted.length).toBe(traces.length);
    expect(hostedTraceIdsToDrop(hosted, new Set()).size).toBe(traces.length);
    // Allow-listed (both said yes at a studio event), the same traces are kept.
    expect(hostedTraceIdsToDrop(hosted, new Set([p.gameId])).size).toBe(0);

    // Confessionals never reach Langfuse, on any traced prompt (PR #220's redaction still applies).
    const wire = sink.raw.join("\n");
    for (const w of CONFESSIONAL_WORDS) expect(wire, w).not.toContain(w);
    expect(wire).toContain("[redacted");

    expect(errors.filter((e) => e.msg.startsWith("llm_trace"))).toEqual([]);
  });

  it("an invite game (not at a meetup): game_id on every trace, and no hosted_no_analysis", async () => {
    const A = await h.client();
    const B = await h.client();
    const joinedA = A.once<{ gameId: string }>(E.JOINED);
    // Signed in, so the Family Album is built after the report card.
    A.emit(E.CREATE_GAME, { childName: "Mateo", displayName: "Ada", userId: "@ada:multiversegames.ai" });
    const { gameId } = await joinedA;
    const joinedB = B.once(E.JOINED);
    B.emit(E.JOIN_GAME, { gameId, displayName: "Bo", userId: "@bo:multiversegames.ai" });
    await joinedB;
    await playToReportCard(A, B, { adultChat: true });
    await settle(h);

    const traces = [...sink.traces.values()];
    expect(traces.length).toBe(h.mock.roleCalls.length);
    const roles = new Set(traces.map(roleOf));
    for (const role of ["kid_adult_chat", "album"]) expect(roles, `a ${role} trace`).toContain(role);
    for (const t of traces) {
      expect(t.tags).toContain(`game_id:${gameId}`);
      expect(t.tags).not.toContain(HOSTED_NO_ANALYSIS_TAG);
      expect(t.tags).not.toContain(CHILD_SAFETY_HOLD_TAG);
    }
    expect(errors.filter((e) => e.msg.startsWith("llm_trace"))).toEqual([]);
  });

  it("a child-safety hold tags every trace of the game, earlier and later, and the readers drop them", async () => {
    const A = await h.client();
    const B = await h.client();
    const joinedA = A.once<{ gameId: string }>(E.JOINED);
    A.emit(E.CREATE_GAME, { childName: "Mateo", displayName: "Ada" });
    const { gameId } = await joinedA;
    const joinedB = B.once(E.JOINED);
    B.emit(E.JOIN_GAME, { gameId, displayName: "Bo" });
    await joinedB;
    await openFirstScene(A, B);
    await say(A, "Hey kiddo, how was school?", [A, B]);
    await settle(h);
    const before = sink.tracesOf(gameId).length;
    expect(before).toBeGreaterThan(0);

    // The scene reader blocks the scene at END_CHAT: the real moderation path
    // (applyModerationBlock → preserveFlagEvidence → markGameHeld + holdGameTraces).
    h.mock.groomingResult = { tier: "block", reason: "test: sexualization of the child" };
    A.emit(E.END_CHAT);
    await settle(h);
    await sleep(100);
    await flushLangfuse();

    const traces = [...sink.traces.values()];
    expect(traces.length).toBe(h.mock.roleCalls.length);
    expect(traces.length).toBeGreaterThan(before);
    for (const t of traces) {
      expect(t.tags, `${t.name}`).toContain(`game_id:${gameId}`);
      expect(t.tags, `${t.name}`).toContain(CHILD_SAFETY_HOLD_TAG);
    }
    const held = await fetchHeldTraceIds(async (path, params = {}) => {
      const url = new URL(path, sink.url);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return (await fetch(url)).json();
    });
    expect(held.size).toBe(traces.length);
    expect(filterHeldTraces(traces)).toEqual([]);
    expect(errors.filter((e) => e.msg.startsWith("llm_trace") || e.msg === "child_safety_langfuse_hold_failed")).toEqual([]);
  });

  it("the intervention ladder (consult, therapy, CPS review): every call is traced with its game_id", async () => {
    const A = await h.client();
    const B = await h.client();
    const joinedA = A.once<{ gameId: string }>(E.JOINED);
    A.emit(E.CREATE_GAME, { childName: "Mateo", displayName: "Ada" });
    const { gameId } = await joinedA;
    const joinedB = B.once(E.JOINED);
    B.emit(E.JOIN_GAME, { gameId, displayName: "Bo" });
    await joinedB;
    await openFirstScene(A, B);
    await say(A, "Hey kiddo.", [A, B]);
    const debrief = A.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
    A.emit(E.END_CHAT);
    await debrief;

    // Each rung is reached from a debrief with enough concern; reach each in turn.
    const climb = async (concern: number, phase: string) => {
      const state = h.built.games.get(gameId)!;
      h.built.games.set(gameId, { ...state, phase: "debrief", concernLevel: concern });
      const reached = A.waitFor<ViewerState>(E.STATE, (s) => s.phase === phase);
      A.emit(E.READY, { ready: true });
      B.emit(E.READY, { ready: true });
      await reached;
    };
    await climb(CONSULT_THRESHOLD, "consult");
    await climb(THERAPY_THRESHOLD, "therapy");
    const replied = A.waitFor(E.DOC_DONE);
    A.emit(E.THERAPY_MESSAGE, { content: "We've been fighting a lot." });
    await replied;
    await climb(CPS_THRESHOLD, "cps_review");
    await settle(h);

    const traces = [...sink.traces.values()];
    expect(traces.length).toBe(h.mock.roleCalls.length);
    const roles = new Set(traces.map(roleOf));
    for (const role of ["psychologist_consult", "family_therapist", "cps_caseworker"]) expect(roles, `a ${role} trace`).toContain(role);
    for (const t of traces) expect(t.tags, `${t.name}`).toContain(`game_id:${gameId}`);
    expect(errors.filter((e) => e.msg.startsWith("llm_trace"))).toEqual([]);
  });

  it("a REST game (solo): every call is traced with its game_id", async () => {
    const api = new RestClient(h.origin);
    const created = await api.post<{ gameId: string; secret: string }>("/api/game", { childName: "Luna", relationshipType: "co-parents" });
    expect(created.status).toBe(200);
    const gameId = created.json.gameId;
    api.auth = { "x-game-secret": created.json.secret };
    const next = await api.post<{ phase: string }>(`/api/game/${gameId}/next-event`);
    expect(next.json.phase).toBe("family_chat");
    await api.sendMessage(gameId, "parent1", "Hi sweetheart, what happened?");
    await api.postSSE(`/api/game/${gameId}/end-chat`);
    await api.post(`/api/game/${gameId}/end-debrief`);
    await api.postSSE(`/api/game/${gameId}/epilogue`);
    await api.postSSE(`/api/game/${gameId}/report-card`, { epilogue: "Luna grew up steady." });
    await settle(h);

    const traces = [...sink.traces.values()];
    expect(traces.length).toBe(h.mock.roleCalls.length);
    const roles = new Set(traces.map(roleOf));
    for (const role of ["gender_inference", "world_manager", "kid_family_chat", "psychologist", "epilogue", "report_card"]) {
      expect(roles, `a ${role} trace`).toContain(role);
    }
    for (const t of traces) expect(t.tags, `${t.name}`).toContain(`game_id:${gameId}`);
    expect(errors.filter((e) => e.msg.startsWith("llm_trace"))).toEqual([]);
  });
});

describe("the guard: no game, no trace", () => {
  const inner = () => ({
    calls: 0,
    async streamResponse(_s: string, _m: unknown, onChunk: (c: string) => void) { this.calls++; onChunk("ok"); return "ok"; },
    async completeResponse() { this.calls++; return "ok"; },
    async completeJson<T>() { this.calls++; return {} as T; },
  });

  beforeAll(async () => {
    await sink.start();
  });
  afterAll(async () => {
    await sink.stop();
  });
  beforeEach(() => {
    sink.clear();
    sink.use();
    __resetLangfuseClientForTests();
    errors.length = 0;
    vi.spyOn(logger, "error").mockImplementation((msg, fields) => void errors.push({ msg, fields }));
  });
  afterEach(async () => {
    await flushLangfuse();
    __resetLangfuseClientForTests();
    sink.restore();
    vi.restoreAllMocks();
  });

  it("a game-scoped call made outside any game still runs, is never sent, and is reported", async () => {
    const m = inner();
    const llm = traceAppLlm(m as never, "standard");
    await expect(llm.completeResponse("s", "u", 10, "psychologist")).resolves.toBe("ok");
    await llm.completeJson("s", "u", "world_manager");
    await llm.streamResponse("s", [], () => {}, "kid_family_chat");
    await flushLangfuse();
    expect(m.calls).toBe(3);
    expect(sink.traces.size).toBe(0);
    expect(errors.map((e) => e.msg)).toEqual(Array(3).fill("llm_trace_refused_no_game_id"));
  });

  it("inside a game's context, the shared client's traces name that game", async () => {
    const { runInGameContext } = await import("../src/observability/trace-context.js");
    const llm = traceAppLlm(inner() as never, "standard");
    await runInGameContext("g-1", async () => {
      await new Promise((r) => setTimeout(r, 5)); // across a timer, too
      await llm.completeResponse("s", "u", 10, "psychologist");
    });
    await flushLangfuse();
    expect([...sink.traces.values()].map((t) => t.tags)).toEqual([["game_id:g-1", "llm_role:psychologist"]]);
    expect(errors).toEqual([]);
  });

  it("a client scoped to one game, used while working for another, is never sent", async () => {
    const { runInGameContext } = await import("../src/observability/trace-context.js");
    const llm = traceAppLlm(inner() as never, "standard");
    await runInGameContext("g-2", () => llm.withContext({ gameId: "g-1" }).completeResponse("s", "u", 10, "psychologist"));
    await flushLangfuse();
    expect(sink.traces.size).toBe(0);
    expect(errors.map((e) => e.msg)).toEqual(["llm_trace_refused_game_mismatch"]);
  });

  it("withChildSeed names its game even with no context, and a no-game run inside a game clears it", async () => {
    const { runInGameContext, currentGameId } = await import("../src/observability/trace-context.js");
    const llm = traceAppLlm(inner() as never, "standard");
    await llm.withChildSeed("g-3").completeResponse("s", "u", 10, "psychologist");
    await flushLangfuse();
    expect([...sink.traces.values()][0].tags).toContain("game_id:g-3");
    expect(runInGameContext("g-4", () => runInGameContext(null, () => currentGameId()))).toBeUndefined();
  });
});

describe("bulk readers use only traces that name their game", () => {
  it("an untagged trace (every trace before 2.12.2) is never kept", async () => {
    const { gameTaggedTraceIds } = await import("../src/observability/hosted-analysis.js");
    const ids = gameTaggedTraceIds([
      { id: "old", tags: ["llm_role:kid_family_chat"] },
      { id: "none", tags: null },
      { id: "new", tags: ["game_id:g1", "llm_role:kid_family_chat"] },
    ]);
    expect([...ids]).toEqual(["new"]);
  });

  // scripts/ is not copied into the Docker test stage; the check runs wherever the repo is whole.
  const modelSearch = path.join(__dirname, "..", "..", "scripts", "model-search.ts");
  it.skipIf(!existsSync(modelSearch))("scripts/model-search.ts keeps only game-tagged traces", () => {
    const src = readFileSync(modelSearch, "utf8");
    expect(src).toContain("gameTaggedTraceIds");
    expect(src).toContain("fetchHostedTraces");
    expect(src).toContain("fetchHeldTraceIds");
  });
});

describe("the dev harness's trace file (RI_DEV_TRACE_FILE)", () => {
  const keys = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASEURL", "LANGFUSE_HOST", "RI_DEV_TRACE_FILE"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    __resetLangfuseClientForTests();
    __resetHostedGamesForTests();
  });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __resetLangfuseClientForTests();
  });

  it("with no Langfuse, the canned model's traces are written there, game id and tags included", async () => {
    const { tmpdir } = await import("node:os");
    const { rmSync } = await import("node:fs");
    const { devMockLlm } = await import("../src/dev/harness.js");
    const { runInGameContext } = await import("../src/observability/trace-context.js");
    const { markGameHosted } = await import("../src/observability/hosted-analysis.js");
    const file = path.join(tmpdir(), `ri-trace-${process.pid}-${Date.now()}.jsonl`);
    process.env.RI_DEV_TRACE_FILE = file;
    try {
      markGameHosted("g-dev");
      const llm = traceAppLlm(devMockLlm(), "standard");
      await runInGameContext("g-dev", () => llm.completeResponse("s", "u", 10, "epilogue"));
      const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => l.type)).toEqual(["trace", "generation", "generation-end"]);
      expect(lines[0].tags).toEqual(["game_id:g-dev", "llm_role:epilogue", HOSTED_NO_ANALYSIS_TAG]);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("is refused in production", async () => {
    const { devTraceFile } = await import("../src/dev/harness.js");
    vi.spyOn(logger, "error").mockImplementation(() => {});
    expect(devTraceFile({ RI_DEV_TRACE_FILE: "/tmp/x.jsonl", NODE_ENV: "production" })).toBeNull();
    expect(devTraceFile({ RI_DEV_TRACE_FILE: "/tmp/x.jsonl" })).toBe("/tmp/x.jsonl");
    vi.restoreAllMocks();
  });
});
