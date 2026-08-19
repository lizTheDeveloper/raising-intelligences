import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import { buildServer, type BuiltServer } from "../src/app.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import { InMemoryAdminQueries } from "../src/db/admin-queries.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { LLMRole } from "../src/llm/model-config.js";
import { TestClient, connect, submitPersonalities, openFirstScene } from "./helpers/socket-client.js";
import { SOCKET_EVENTS as E } from "../src/socket/protocol.js";
import type { ViewerState } from "../src/socket/protocol.js";
import type { GameEvent, Message } from "../src/types.js";
import {
  buildKidContext,
  buildPsychologistContext,
  buildSceneTranscript,
  buildWorldManagerContext,
  currentEventMessages,
} from "../src/game/context-assembler.js";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { createGame, transition, PARENT_MESSAGE_CAP } from "../src/game/state-machine.js";

/**
 * Server-side fixes from the 2026-07-31 partner playtest (docs/playtest-notes.md):
 * item 3 (multiplayer scene prefetch), item 5 (typing co-presence), item 6
 * (the debrief has no chat), item 7 (stale `generating` flag), plus the live
 * follow-up report "it dropped us back into the same conversation".
 */

function mockEvent(n: number): GameEvent {
  return {
    eventNumber: n,
    age: 3 + n,
    description: `Scenario ${n}.`,
    setting: "Home",
    trigger: `Trigger ${n}`,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * MockLLMClient that can hold the world-manager call open, so a test can
 * observe the server *while* a scenario is generating — which is the only
 * window in which `generating` means anything.
 */
class GatedMockLLMClient extends MockLLMClient {
  private held: Promise<void> | null = null;
  private release: (() => void) | null = null;

  /** Make the next world_manager call block until `letGo()`. */
  hold(): void {
    this.held = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  letGo(): void {
    this.release?.();
    this.release = null;
    this.held = null;
  }

  override async completeJson<T>(system: string, userMessage: string, role?: LLMRole): Promise<T> {
    if (role === "world_manager" && this.held) {
      await this.held;
    }
    return super.completeJson<T>(system, userMessage, role);
  }
}

describe("Playtest fixes (server)", () => {
  let built: BuiltServer;
  let baseUrl: string;
  let mock: GatedMockLLMClient;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    process.env.DISABLE_PORTRAITS = "1";
    mock = new GatedMockLLMClient();
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

  async function client(): Promise<TestClient> {
    const c = await connect(baseUrl);
    clients.push(c);
    return c;
  }

  interface Pair {
    p1: TestClient;
    p2: TestClient;
    gameId: string;
    token1: string;
    token2: string;
  }

  async function pair(childName: string): Promise<Pair> {
    // Plenty of scenarios: the world manager is called once per scene AND once
    // per end-of-scene prefetch.
    mock.events = Array.from({ length: 12 }, (_, i) => mockEvent(i + 1));
    // The mock instance is shared across the file; role accounting is per-game.
    mock.roleCalls = [];

    const p1 = await client();
    const joined1 = p1.once<{ gameId: string; playerToken: string }>(E.JOINED);
    p1.emit(E.CREATE_GAME, { childName });
    const j1 = await joined1;

    const p2 = await client();
    const joined2 = p2.once<{ playerToken: string }>(E.JOINED);
    p2.emit(E.JOIN_GAME, { gameId: j1.gameId });
    const j2 = await joined2;

    return {
      p1,
      p2,
      gameId: j1.gameId,
      token1: j1.playerToken,
      token2: j2.playerToken,
    };
  }

  /** Both players ready up; resolve once `predicate` holds on parent 1's STATE. */
  async function advance(p: Pair, predicate: (s: ViewerState) => boolean): Promise<ViewerState> {
    const landed = p.p1.waitFor<ViewerState>(E.STATE, predicate);
    p.p1.emit(E.READY, { ready: true });
    p.p2.emit(E.READY, { ready: true });
    return landed;
  }

  /**
   * Lobby → guardian quiz → family chat with a scenario attached.
   *
   * Still one ready gate. Since the 2026-07-31 opening reorder (item 1) the
   * gate no longer generates the scene — submitting the personality quiz does,
   * so the world manager sees the seed and both parents.
   */
  async function toFamilyChat(p: Pair): Promise<ViewerState> {
    return openFirstScene(p.p1, p.p2);
  }

  async function say(from: TestClient, content: string, observer: TestClient): Promise<void> {
    const done = observer.once(E.MESSAGE_DONE);
    from.emit(E.PARENT_MESSAGE, { content });
    await done;
  }

  /** Play one message, then end the scene and land both players in the debrief. */
  async function toDebrief(p: Pair): Promise<ViewerState> {
    await toFamilyChat(p);
    await say(p.p1, "What happened at school today?", p.p2);
    const debrief = p.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
    p.p1.emit(E.END_CHAT);
    return debrief;
  }

  const worldManagerCalls = () => mock.roleCalls.filter((r) => r === "world_manager").length;

  // ---------------------------------------------------------------- item 6 --
  describe("debrief chat (note 6)", () => {
    it("carries a parent message with the kid asleep — no LLM turn, no scene-cap spend", async () => {
      const p = await pair("Wren");
      const before = await toDebrief(p);
      expect(before.phase).toBe("debrief");

      const rolesBefore = mock.roleCalls.length;
      const countBefore = before.parentMessageCount;
      const remainingBefore = before.messagesRemaining;
      p.p1.resetStream();
      p.p2.resetStream();

      await say(p.p1, "I froze back there. I didn't know what to say.", p.p2);
      // Give any (incorrect) follow-on generation a chance to surface.
      await delay(100);

      const after = p.p2.lastState!;
      const debriefMsgs = after.messages.filter((m: Message) => m.chatType === "debrief");
      expect(debriefMsgs.length).toBe(1);
      expect(debriefMsgs[0]!.sender).toBe("parent1");
      expect(debriefMsgs[0]!.content).toContain("I froze back there");

      // The kid is asleep: not a recipient, and no model was asked anything.
      expect(debriefMsgs[0]!.visibleTo).toEqual(["parent1", "parent2"]);
      expect(debriefMsgs[0]!.visibleTo).not.toContain("kid");
      expect(mock.roleCalls.length).toBe(rolesBefore);
      expect(p.p1.kidStream).toBe("");
      expect(p.p2.kidStream).toBe("");

      // Neither the phase nor the per-scene family-chat budget moved.
      expect(after.phase).toBe("debrief");
      expect(after.parentMessageCount).toBe(countBefore);
      expect(after.messagesRemaining).toBe(remainingBefore);
      expect(p.p1.lastError).toBeUndefined();
      expect(p.p2.lastError).toBeUndefined();
    });

    it("is not capped by PARENT_MESSAGE_CAP and never ends the scene", async () => {
      const p = await pair("Idris");
      await toDebrief(p);
      const rolesBefore = mock.roleCalls.length;

      // Comfortably past the per-scene family-chat budget.
      for (let i = 0; i < PARENT_MESSAGE_CAP + 3; i++) {
        await say(i % 2 === 0 ? p.p1 : p.p2, `debrief line ${i}`, p.p2);
      }

      const after = p.p1.lastState!;
      expect(after.messages.filter((m: Message) => m.chatType === "debrief").length).toBe(
        PARENT_MESSAGE_CAP + 3
      );
      expect(after.phase).toBe("debrief");
      expect(mock.roleCalls.length).toBe(rolesBefore);
      expect(p.p1.lastError).toBeUndefined();
    });

    it("keeps debrief messages out of every LLM context", () => {
      let state = createGame("Nell");
      state = transition(state, { type: "START_EVENT", event: mockEvent(1) });
      state = transition(state, {
        type: "PARENT_MESSAGE",
        sender: "parent1",
        content: "SHARED_MARKER take your shoes off",
      });
      state = transition(state, { type: "KID_MESSAGE", content: "no!" });
      state = transition(state, { type: "END_FAMILY_CHAT" });
      state = transition(state, { type: "IDENTITY_UPDATED", document: "Doc." });
      expect(state.phase).toBe("debrief");
      state = transition(state, {
        type: "PARENT_MESSAGE",
        sender: "parent2",
        content: "DEBRIEF_MARKER you were too hard on them",
      });

      // The design decision: the debrief is deliberately unobserved.
      expect(currentEventMessages(state).map((m) => m.content).join("\n")).not.toContain(
        "DEBRIEF_MARKER"
      );
      expect(buildSceneTranscript(state)).not.toContain("DEBRIEF_MARKER");
      expect(buildSceneTranscript(state)).toContain("SHARED_MARKER");
      expect(buildPsychologistContext(state).userMessage).not.toContain("DEBRIEF_MARKER");
      const wm = buildWorldManagerContext(state);
      expect(wm.system + wm.userMessage).not.toContain("DEBRIEF_MARKER");
      const kid = buildKidContext(state);
      expect(JSON.stringify(kid.messages)).not.toContain("DEBRIEF_MARKER");
    });

    it("refuses a debrief message on the kid-turn engine path (REST has no phase guard)", async () => {
      const engine = new ConversationEngine(new MockLLMClient());
      let state = createGame("Ola");
      state = transition(state, { type: "START_EVENT", event: mockEvent(1) });
      state = transition(state, { type: "END_FAMILY_CHAT" });
      state = transition(state, { type: "IDENTITY_UPDATED", document: "Doc." });

      const before = state.messages.length;
      await expect(
        engine.handleParentMessage(state, "parent1", "just us now")
      ).rejects.toThrow(/debrief/);
      // Rejected before anything was appended — no half-applied state.
      expect(state.messages.length).toBe(before);
    });
  });

  // ---------------------------------------------------------------- item 7 --
  describe("`generating` on ViewerState (note 7)", () => {
    it("rides on STATE while the scenario generates and clears when it lands", async () => {
      const p = await pair("Juno");
      mock.hold();

      const generatingState = p.p2.waitFor<ViewerState>(E.STATE, (s) => s.generating === true);
      const chatting = p.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
      submitPersonalities(p.p1, p.p2);

      // While generating, STATE itself says so — and no scene is being shown.
      const mid = await generatingState;
      expect(mid.generating).toBe(true);
      expect(mid.currentEvent).toBeNull();

      mock.letGo();
      const landed = await chatting;
      expect(landed.generating).toBe(false);
      expect(landed.currentEvent).not.toBeNull();
    });

    it("re-syncs a reconnecting client mid-generation, which GENERATING alone never did", async () => {
      const p = await pair("Rune");
      mock.hold();

      const started = p.p2.waitFor<ViewerState>(E.STATE, (s) => s.generating === true);
      submitPersonalities(p.p1, p.p2);
      await started;

      // Token reconnect emits STATE and no GENERATING event — before the flag
      // lived on ViewerState this client had no way to learn it was waiting.
      const rejoined = p.p2.waitFor<ViewerState>(E.STATE, () => true);
      p.p2.emit(E.JOIN_GAME, { gameId: p.gameId, playerToken: p.token2 });
      expect((await rejoined).generating).toBe(true);

      mock.letGo();
      const settled = await p.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "family_chat");
      expect(settled.generating).toBe(false);
    });

    it("reports false on a fresh join when nothing is generating", async () => {
      const p = await pair("Tam");
      // `pair` awaits the JOINED ack; the joining player's first STATE
      // broadcast lands on a later tick. Reading `lastState` synchronously
      // raced that broadcast and failed intermittently under load — take
      // whichever has already arrived, otherwise wait for it.
      const s = p.p2.lastState ?? (await p.p2.waitFor<ViewerState>(E.STATE));
      expect(s.generating).toBe(false);
    });
  });

  // ---------------------------------------------------------------- item 3 --
  describe("multiplayer scene prefetch (note 3)", () => {
    it("generates the next scene at scene end so the event_intro gate costs no model call", async () => {
      const p = await pair("Sol");
      await toFamilyChat(p);
      expect(worldManagerCalls()).toBe(1); // scene 1, generated at the gate

      await say(p.p1, "Come sit with me a minute.", p.p2);
      const debrief = p.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
      p.p1.emit(E.END_CHAT);
      await debrief;
      await delay(50);

      // Scene 2 was already generated, in parallel with the psychologist.
      expect(worldManagerCalls()).toBe(2);
      const afterPrefetch = worldManagerCalls();

      // "next chapter" → event_intro, then the gate into scene 2.
      const intro = await advance(p, (s) => s.phase === "event_intro" && s.currentEvent === null);
      expect(intro.currentEvent).toBeNull();

      const scene2 = await advance(
        p,
        (s) => s.phase === "family_chat" && s.currentEventNumber === 2
      );
      expect(scene2.currentEvent!.description).toContain("Scenario 2");

      // The gate consumed the prefetch instead of making its own call.
      expect(worldManagerCalls()).toBe(afterPrefetch);
      expect(p.p1.lastError).toBeUndefined();
    });

    it("falls back to a synchronous load when no prefetch is available", async () => {
      const p = await pair("Bex");
      // First scene of a game: nothing was prefetched, so the gate must still
      // produce a scenario on its own.
      const chatting = await toFamilyChat(p);
      expect(chatting.currentEvent).not.toBeNull();
      expect(worldManagerCalls()).toBe(1);
    });
  });

  // ---------------------------------------------------------------- item 5 --
  describe("typing co-presence (note 5)", () => {
    it("relays a typing signal to the co-parent and never back to the sender", async () => {
      const p = await pair("Mika");

      let echoed = false;
      p.p1.socket.on(E.TYPING, () => {
        echoed = true;
      });
      const seen = p.p2.waitFor<{ slot: string; typing: boolean }>(E.TYPING);
      p.p1.emit(E.TYPING, { typing: true });
      expect(await seen).toEqual({ slot: "parent1", typing: true });

      const cleared = p.p2.waitFor<{ slot: string; typing: boolean }>(
        E.TYPING,
        (t) => t.typing === false
      );
      p.p1.emit(E.TYPING, { typing: false });
      expect(await cleared).toEqual({ slot: "parent1", typing: false });

      await delay(100);
      expect(echoed).toBe(false);
    });

    it("ignores a typing signal from a socket that is not in a game", async () => {
      const stranger = await client();
      let sawAnything = false;
      stranger.socket.on(E.TYPING, () => {
        sawAnything = true;
      });
      stranger.emit(E.TYPING, { typing: true });
      await delay(100);
      // Silently dropped — not an ERROR frame, not a broadcast.
      expect(stranger.lastError).toBeUndefined();
      expect(sawAnything).toBe(false);
    });
  });

  // ------------------------------------------- live follow-up (item 8) ------
  describe("rehydrated games never replay the scene they just finished", () => {
    it("drops a stale currentEvent on reload and generates a fresh scene", async () => {
      const p = await pair("Halla");
      await toFamilyChat(p);
      await say(p.p1, "Tell me about it.", p.p2);
      const debrief = p.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
      p.p1.emit(E.END_CHAT);
      await debrief;

      // "next chapter" — END_DEBRIEF nulls currentEvent but leaves
      // currentEventNumber at 1, which is exactly what gets persisted.
      await advance(p, (s) => s.phase === "event_intro" && s.currentEvent === null);

      // Force the reload path: this is what a process restart, an invite link
      // resumed later, or the 4h eviction sweep produces.
      built.games.delete(p.gameId);

      const rejoined = p.p2.waitFor<ViewerState>(E.STATE, () => true);
      p.p2.emit(E.JOIN_GAME, { gameId: p.gameId, playerToken: p.token2 });
      const restored = await rejoined;

      // Before the fix, reconstructState resurrected scene 1 here — the
      // event_intro screen rendered a finished scene's description (note 7)
      // and the next gate dropped both players back into it.
      expect(restored.phase).toBe("event_intro");
      expect(restored.currentEvent).toBeNull();

      const scene2 = await advance(p, (s) => s.phase === "family_chat");
      expect(scene2.currentEventNumber).toBe(2);
      expect(scene2.currentEvent!.description).toContain("Scenario 2");
      // The finished scene's transcript is still in history, but the live
      // scene is a new one — the pair are not replaying it.
      expect(
        scene2.messages.filter((m: Message) => m.eventNumber === 2 && m.chatType !== "debrief")
          .length
      ).toBe(0);
      expect(p.p1.lastError).toBeUndefined();
      expect(p.p2.lastError).toBeUndefined();
    });

    it("uses the identity snapshot when a scene ended with no messages at all", async () => {
      const p = await pair("Ozan");
      await toFamilyChat(p);
      // endChat has no minimum-message guard, so this scene leaves no messages
      // — the snapshot IDENTITY_UPDATED writes is the only marker that it ran.
      const debrief = p.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "debrief");
      p.p1.emit(E.END_CHAT);
      await debrief;
      await advance(p, (s) => s.phase === "event_intro" && s.currentEvent === null);

      built.games.delete(p.gameId);
      const rejoined = p.p2.waitFor<ViewerState>(E.STATE, () => true);
      p.p2.emit(E.JOIN_GAME, { gameId: p.gameId, playerToken: p.token2 });
      expect((await rejoined).currentEvent).toBeNull();

      const scene2 = await advance(p, (s) => s.phase === "family_chat");
      expect(scene2.currentEventNumber).toBe(2);
      expect(scene2.currentEvent!.description).toContain("Scenario 2");
    });
  });

  // --------------------------------- adult chat needs its own event number --
  describe("adult chat is a distinct scene", () => {
    it("advances currentEventNumber so its messages never collide with the last childhood scene", () => {
      let state = createGame("Pim");
      state = transition(state, { type: "START_EVENT", event: mockEvent(1) });
      state = transition(state, {
        type: "PARENT_MESSAGE",
        sender: "parent1",
        content: "CHILDHOOD_MARKER bedtime",
      });
      state = transition(state, { type: "KID_MESSAGE", content: "five more minutes" });
      const childhoodNumber = state.currentEventNumber;

      state = transition(state, { type: "END_FAMILY_CHAT" });
      state = transition(state, { type: "IDENTITY_UPDATED", document: "Doc." });
      state = transition(state, { type: "END_DEBRIEF" });

      const adultEvent: GameEvent = {
        // Mirrors endgame-engine.startAdultConversation, which already stamps
        // `state.currentEventNumber + 1` — so the appended event's own number
        // matches the advanced currentEventNumber, keeping it out of
        // buildKidContext's "prior events" recap and giving album age labels a
        // real event to resolve against.
        eventNumber: state.currentEventNumber + 1,
        age: 27,
        description: "Coffee, years later.",
        setting: "A cafe",
        trigger: "They called first",
      };
      state = transition(state, { type: "START_ADULT_CHAT", event: adultEvent });
      // PARENT_MESSAGE is a legal transition from `adult_chat` now, so drive
      // both halves of the turn. Same stamping either way — messages take
      // `state.currentEventNumber` at creation time.
      state = transition(state, {
        type: "PARENT_MESSAGE",
        sender: "parent1",
        content: "ADULT_MARKER I've thought about that day a lot.",
      });
      state = transition(state, {
        type: "KID_MESSAGE",
        content: "ADULT_MARKER how have you been?",
      });

      expect(state.phase).toBe("adult_chat");
      expect(state.currentEventNumber).toBe(childhoodNumber + 1);
      expect(state.events).toContain(adultEvent);
      // The appended event agrees with the phase's own event number.
      expect(adultEvent.eventNumber).toBe(state.currentEventNumber);
      // …so it is not replayed to the kid as one of their own prior life
      // events (that recap renders "- Age {age}: {trigger}"). The scenario
      // still arrives as the current situation, which is the point of it.
      const kidSystem = buildKidContext(state).system;
      expect(kidSystem).not.toContain("Age 27: They called first");
      expect(kidSystem).toContain("Coffee, years later");

      const adultMsg = state.messages.find((m) => m.content.includes("ADULT_MARKER"))!;
      const childMsg = state.messages.find((m) => m.content.includes("CHILDHOOD_MARKER"))!;
      expect(adultMsg.eventNumber).not.toBe(childMsg.eventNumber);
      expect(adultMsg.eventNumber).toBe(state.currentEventNumber);

      // A per-scene transcript filter now isolates the adult conversation.
      const scene = currentEventMessages(state);
      expect(scene.map((m) => m.content).join("\n")).toContain("ADULT_MARKER");
      expect(scene.map((m) => m.content).join("\n")).not.toContain("CHILDHOOD_MARKER");
      // …and so does the kid's own context for the adult conversation.
      expect(JSON.stringify(buildKidContext(state).messages)).not.toContain("CHILDHOOD_MARKER");
    });
  });

  // ----------------------------------------- live follow-up: frozen view ----
  describe("STATE reaches every socket a player has open", () => {
    it("keeps a superseded socket in sync instead of freezing it on the last scene", async () => {
      const p = await pair("Vero");
      await toFamilyChat(p);

      // A second connection claims parent2's slot with the same token — a
      // second tab, or a client that re-dialled without tearing the old socket
      // down. `reconnectPlayer` repoints `connectionId` at this new socket.
      const p2b = await client();
      const joinedAgain = p2b.once(E.JOINED);
      p2b.emit(E.JOIN_GAME, { gameId: p.gameId, playerToken: p.token2 });
      await joinedAgain;

      // The ORIGINAL parent2 socket is still in the room and still on screen.
      // Before the slot-room fix it received LOBBY and GENERATING forever but
      // never another STATE: ready counts and "building the next scene…" ticked
      // along live over a game view frozen at this scene.
      const oldSocketUpdate = p.p2.waitFor<ViewerState>(
        E.STATE,
        (s) => s.messages.some((m: Message) => m.content.includes("STILL_HERE"))
      );
      const newSocketUpdate = p2b.waitFor<ViewerState>(
        E.STATE,
        (s) => s.messages.some((m: Message) => m.content.includes("STILL_HERE"))
      );
      p.p1.emit(E.PARENT_MESSAGE, { content: "STILL_HERE are you okay?" });

      const onOld = await oldSocketUpdate;
      const onNew = await newSocketUpdate;
      expect(onOld.messages.length).toBe(onNew.messages.length);
      expect(onOld.phase).toBe("family_chat");
    });

    it("does not leak parent1's state into parent2's slot room", async () => {
      const p = await pair("Anwen");
      await toFamilyChat(p);

      // parent1 opens a private sidebar; parent2's sockets must see nothing.
      const sidebar = p.p1.waitFor<ViewerState>(E.STATE, (s) => s.phase === "sidebar");
      p.p1.emit(E.START_SIDEBAR);
      await sidebar;

      p.p1.resetStream();
      p.p2.resetStream();
      const before = p.p2.lastState!.messages.length;
      await say(p.p1, "SIDEBAR_SECRET just between us", p.p1);
      await delay(100);

      expect(p.p1.kidStream.length).toBeGreaterThan(0);
      expect(p.p2.kidStream).toBe("");
      expect(p.p2.lastState!.messages.length).toBe(before);
      expect(
        p.p2.lastState!.messages.some((m: Message) => m.content.includes("SIDEBAR_SECRET"))
      ).toBe(false);
    });
  });
});
