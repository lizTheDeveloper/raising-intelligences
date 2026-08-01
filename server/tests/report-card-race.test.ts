import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import type { AddressInfo } from "net";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { EndgameEngine } from "../src/game/endgame-engine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { registerSocketHandlers } from "../src/socket/handlers.js";
import type { Session } from "../src/game/session-manager.js";
import type { GameEvent, GameState } from "../src/types.js";
import type { LLMClient } from "../src/llm/client.js";
import type { LLMRole } from "../src/llm/model-config.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import { TestClient, connect, openFirstScene } from "./helpers/socket-client.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Distinctive enough that finding it in the report-card prompt proves the
 * server used the real epilogue and not an empty string. */
const EPILOGUE_TEXT =
  "SENTINEL-EPILOGUE Rowan grew up to plant orchards on the roofs of hospitals.";

function mockEvent(n: number): GameEvent {
  return {
    eventNumber: n,
    age: 3 + n,
    description: `Scenario ${n}.`,
    setting: "Home",
    trigger: `Trigger ${n}`,
  };
}

/**
 * MockLLMClient with two additions the report-card tests need.
 *
 * 1. A **gate** on the `report_card` call. Without it these tests cannot
 *    discriminate: MockLLMClient resolves immediately, so the first handler's
 *    entire continuation runs as microtasks before the second socket event's
 *    I/O callback is even dequeued — the idempotency guard alone would catch
 *    the duplicate and a lock-less server would still pass. Holding the model
 *    call open is what puts two presses genuinely in flight at once, which is
 *    the real-world case: this is a two-player screen and the model call takes
 *    tens of seconds.
 * 2. Role-aware text. The base mock returns `identityUpdates` for every
 *    `completeResponse`, so the epilogue and the report card are
 *    indistinguishable. Here the epilogue gets its own sentinel string and the
 *    report-card prompt is captured, so a test can assert what the server
 *    actually fed the model.
 */
class GatedLLM implements LLMClient {
  readonly mock = new MockLLMClient();
  reportCardCalls = 0;
  epilogueCalls = 0;
  /** The `userMessage` of the most recent report-card call. */
  lastReportCardPrompt = "";
  /** Resolves the first time a report-card call is entered. */
  readonly firstReportCardEntered: Promise<void>;
  /** Resolves the first time an epilogue call is entered. */
  readonly firstEpilogueEntered: Promise<void>;
  private signalEntered: Record<"report_card" | "epilogue", () => void>;
  private release: Partial<Record<"report_card" | "epilogue", () => void>> = {};
  private gate: Partial<Record<"report_card" | "epilogue", Promise<void>>> = {};

  constructor() {
    let signalReport!: () => void;
    let signalEpilogue!: () => void;
    this.firstReportCardEntered = new Promise<void>((r) => (signalReport = r));
    this.firstEpilogueEntered = new Promise<void>((r) => (signalEpilogue = r));
    this.signalEntered = { report_card: signalReport, epilogue: signalEpilogue };
  }

  /** Hold every call for `role` until `release(role)` is called. */
  hold(role: "report_card" | "epilogue"): void {
    this.gate[role] = new Promise<void>((r) => (this.release[role] = r));
  }

  releaseRole(role: "report_card" | "epilogue"): void {
    this.release[role]?.();
    delete this.gate[role];
    delete this.release[role];
  }

  streamResponse(
    system: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    onChunk: (chunk: string) => void,
    role?: LLMRole
  ): Promise<string> {
    return this.mock.streamResponse(system, messages, onChunk, role);
  }

  async completeResponse(
    system: string,
    userMessage: string,
    maxTokens?: number,
    role?: LLMRole,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    if (role === "epilogue") {
      this.mock.roleCalls.push(role);
      this.epilogueCalls++;
      this.signalEntered.epilogue();
      if (this.gate.epilogue) await this.gate.epilogue;
      if (onChunk) onChunk(EPILOGUE_TEXT);
      return EPILOGUE_TEXT;
    }
    if (role === "report_card") {
      this.mock.roleCalls.push(role);
      this.reportCardCalls++;
      this.lastReportCardPrompt = userMessage;
      this.signalEntered.report_card();
      if (this.gate.report_card) await this.gate.report_card;
      const text = "# Report Card\nRowan is steady.";
      if (onChunk) onChunk(text);
      return text;
    }
    return this.mock.completeResponse(system, userMessage, maxTokens, role, onChunk);
  }

  completeJson<T>(system: string, userMessage: string, role?: LLMRole): Promise<T> {
    return this.mock.completeJson<T>(system, userMessage, role);
  }
}

/**
 * The report card is an expensive model call reached from a screen BOTH players
 * are looking at (the epilogue's "continue", and `adult_chat`'s "finish"). It
 * is therefore the one place where two simultaneous presses are the expected
 * case, and where a client that arrived late — a reload, a second tab, a phone
 * picked up after the epilogue was generated — has to be able to ask for it
 * without holding a copy of the epilogue itself.
 */
describe("report card: concurrent presses and late-arriving clients", () => {
  let httpServer: HttpServer;
  let io: SocketServer;
  let baseUrl: string;
  let llm: GatedLLM;
  const clients: TestClient[] = [];

  async function boot(): Promise<void> {
    process.env.DISABLE_PORTRAITS = "1";
    llm = new GatedLLM();
    llm.mock.events = Array.from({ length: 6 }, (_, i) => mockEvent(i + 1));
    llm.mock.kidResponses = ["I didn't mean to."];
    httpServer = createServer();
    io = new SocketServer(httpServer);
    registerSocketHandlers({
      io,
      games: new Map<string, GameState>(),
      sessions: new Map<string, Session>(),
      conversationEngine: new ConversationEngine(llm),
      endgameEngine: new EndgameEngine(llm),
      repo: new InMemoryGameRepository(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  }

  async function client(): Promise<TestClient> {
    const c = await connect(baseUrl);
    clients.push(c);
    return c;
  }

  /**
   * A two-player game driven through the real socket path to the `debrief`
   * phase: lobby → guardian quiz → scene 1 → END_CHAT. This is where the
   * epilogue's own button lives.
   */
  async function atDebrief(): Promise<{ p1: TestClient; p2: TestClient; gameId: string }> {
    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Rowan", displayName: "Alex" });
    const { gameId } = await joined1;

    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId, displayName: "Sam" });
    await joined2;

    await openFirstScene(p1, p2);

    const debrief = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
    p1.emit(E.END_CHAT);
    await debrief;

    return { p1, p2, gameId };
  }

  /**
   * …and on into `epilogue`. Both clients are present when it is generated, so
   * both hold it locally — which is the state the report-card race test wants,
   * and the state the handoff test deliberately does NOT give its third client.
   */
  async function atEpilogue(): Promise<{ p1: TestClient; p2: TestClient; gameId: string }> {
    const pair = await atDebrief();
    const epilogue = pair.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "epilogue");
    pair.p1.emit(E.START_EPILOGUE);
    await epilogue;
    return pair;
  }

  beforeEach(async () => {
    await boot();
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("generates exactly one report card when both players press at the same moment", async () => {
    const { p1, p2 } = await atEpilogue();

    // Hold the model call open so both presses are genuinely in flight — the
    // whole point. The idempotency guard reads a phase that only changes after
    // this call returns, so inside this window it cannot help: only the game
    // lock can.
    llm.hold("report_card");

    const ready = p1.waitFor<{ reportCard: string }>(E.REPORT_CARD_READY);
    p1.emit(E.REPORT_CARD, { epilogue: EPILOGUE_TEXT });
    p2.emit(E.REPORT_CARD, { epilogue: EPILOGUE_TEXT });

    // Wait for the first call to be observed rather than guessing at a delay,
    // then give the second press's socket event time to be delivered and
    // handled while the first is still inside the model call.
    await llm.firstReportCardEntered;
    await delay(150);

    llm.releaseRole("report_card");
    const rc = await ready;
    expect(rc.reportCard).toContain("Report Card");

    // Let a second (erroneous) generation settle before asserting.
    await delay(150);

    // One press, one report card. Without the lock the second press passes the
    // phase guard while the first is still awaiting the model, and this is 2.
    expect(llm.reportCardCalls).toBe(1);
    expect(p1.lastError).toBeUndefined();
    expect(p2.lastError).toBeUndefined();
    expect(p1.lastState!.phase).toBe("report_card");
    expect(p2.lastState!.phase).toBe("report_card");
  });

  it("generates exactly one epilogue when both players press 'continue' at the same moment", async () => {
    const { p1, p2 } = await atDebrief();

    // Hold the epilogue call open, exactly as the report-card race does: the
    // phase only leaves `debrief` when this returns, so inside this window a
    // phase guard on its own cannot tell the second press from the first.
    llm.hold("epilogue");

    const landed = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "epilogue");
    p1.emit(E.START_EPILOGUE);
    p2.emit(E.START_EPILOGUE);

    await llm.firstEpilogueEntered;
    await delay(150);

    llm.releaseRole("epilogue");
    await landed;
    await delay(150);

    // One epilogue. Unserialized, the second press generated another and
    // overwrote the first — which since the epilogue moved into GameState
    // means replacing the text a player may already be reading, and the text
    // the report card is then built from.
    expect(llm.epilogueCalls).toBe(1);
    expect(p1.lastState!.epilogue).toBe(EPILOGUE_TEXT);
    expect(p2.lastState!.epilogue).toBe(EPILOGUE_TEXT);
    expect(p1.lastError).toBeUndefined();
    expect(p2.lastError).toBeUndefined();
  });

  it("a repeat START_EPILOGUE re-sends the existing epilogue instead of generating another", async () => {
    const { p1, p2 } = await atEpilogue();
    expect(llm.epilogueCalls).toBe(1);

    // A stale client, a reload, or simply the other parent pressing the button
    // they can still see. It must get the epilogue back, not a new one.
    const resent = p2.once<{ epilogue: string }>(E.EPILOGUE);
    p2.emit(E.START_EPILOGUE);
    expect((await resent).epilogue).toBe(EPILOGUE_TEXT);

    await delay(100);
    expect(llm.epilogueCalls).toBe(1);
    expect(p2.lastError).toBeUndefined();
  });

  it("ignores START_EPILOGUE from a phase the state machine forbids, without burning a call", async () => {
    // `family_chat` is not one of canTransition's permitted phases
    // (event_intro, debrief, cps_review). The old handler generated the whole
    // epilogue first and only then threw "Invalid transition" over it.
    const p1 = await client();
    const joined1 = p1.once<{ gameId: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName: "Rowan", displayName: "Alex" });
    await joined1;
    const p2 = await client();
    const joined2 = p2.once(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId: (await joined1).gameId, displayName: "Sam" });
    await joined2;
    const scene = await openFirstScene(p1, p2);
    expect(scene.phase).toBe("family_chat");

    p1.emit(E.START_EPILOGUE);
    await delay(150);

    expect(llm.epilogueCalls).toBe(0);
    expect(p1.lastState!.phase).toBe("family_chat");
    expect(p1.lastError).toBeUndefined();
  });

  it("a device that picked the game up after the epilogue still produces a real report card", async () => {
    const { p1, gameId } = await atEpilogue();

    // The phone. It joins by handoff code — a shipped feature, and a cold load
    // on a new device — so it has never received the one-shot E.EPILOGUE event
    // and cannot have a local copy of the epilogue.
    const minted = p1.once<{ code: string }>(E.HANDOFF_CODE);
    p1.emit(E.REQUEST_HANDOFF);
    const { code } = await minted;

    const phone = await client();
    const landed = phone.once<{ slot: string }>(E.JOINED);
    const firstState = phone.waitFor<ViewerState>(E.STATE);
    phone.emit(E.JOIN_GAME, { gameId, handoffCode: code });
    await landed;

    // The epilogue rides on STATE, so the new device can render the screen it
    // just landed on instead of an empty one.
    const state = await firstState;
    expect(state.phase).toBe("epilogue");
    expect(state.epilogue).toBe(EPILOGUE_TEXT);

    // Press "continue" with NO epilogue in the payload at all — the honest
    // representation of a client that never saw it. Before the fix this
    // generated the report card from "".
    const ready = phone.waitFor<{ reportCard: string }>(E.REPORT_CARD_READY);
    phone.emit(E.REPORT_CARD);
    await ready;

    expect(llm.reportCardCalls).toBe(1);
    // The assertion that bites: the model was given the real epilogue.
    expect(llm.lastReportCardPrompt).toContain(EPILOGUE_TEXT);
    expect(phone.lastError).toBeUndefined();
  });

  it("keeps the epilogue on STATE through adult_chat, so the report card there sees it too", async () => {
    const { p1 } = await atEpilogue();

    const inAdult = p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "adult_chat");
    p1.emit(E.ADULT_CHAT, { scenario: "Rowan calls about a job across the country." });
    expect((await inAdult).epilogue).toBe(EPILOGUE_TEXT);

    const ready = p1.waitFor<{ reportCard: string }>(E.REPORT_CARD_READY);
    p1.emit(E.REPORT_CARD);
    await ready;

    expect(llm.lastReportCardPrompt).toContain(EPILOGUE_TEXT);
  });
});
