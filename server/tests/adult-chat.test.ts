import { describe, it, expect } from "vitest";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { EndgameEngine } from "../src/game/endgame-engine.js";
import {
  createGame,
  transition,
  canTransition,
  PARENT_MESSAGE_CAP,
} from "../src/game/state-machine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import { InMemoryGameRepository } from "../src/db/repository.js";
import type { GameEvent, GameState } from "../src/types.js";

const childhoodEvent: GameEvent = {
  eventNumber: 1,
  age: 4,
  description: "Your child is 4. They broke a vase.",
  setting: "Living room",
  trigger: "Accident",
};

const SCENARIO = "Luna calls you, unsure whether to take a job across the country.";

/** A game that has finished childhood and been walked into `adult_chat` through
 * the real path — endgame-engine.startAdultConversation — rather than by
 * hand-setting `phase`. The phase has no UI entry point in either client (it is
 * reachable only via the socket ADULT_CHAT event and POST /game/:id/adult-chat),
 * so driving the engine is the closest thing to how it is actually entered. */
async function inAdultChat(mock: MockLLMClient): Promise<GameState> {
  let state = createGame("Luna");
  state = transition(state, { type: "START_EVENT", event: childhoodEvent });
  state = transition(state, {
    type: "PARENT_MESSAGE",
    sender: "parent1",
    content: "CHILDHOOD it's okay, accidents happen.",
  });
  state = transition(state, { type: "KID_MESSAGE", content: "CHILDHOOD I'm sorry." });
  state = transition(state, { type: "END_FAMILY_CHAT" });
  state = transition(state, { type: "IDENTITY_UPDATED", document: "Core beliefs: mistakes are survivable." });
  state = transition(state, { type: "END_DEBRIEF" });

  const endgame = new EndgameEngine(mock);
  const { state: afterEpilogue } = await endgame.generateEpilogue(state);
  return endgame.startAdultConversation(afterEpilogue, SCENARIO);
}

describe("adult_chat is a live conversation", () => {
  it("accepts a parent message and produces a reply from the grown child", async () => {
    const mock = new MockLLMClient();
    mock.kidResponses = ["I've been thinking about it too."];
    const state = await inAdultChat(mock);
    const engine = new ConversationEngine(mock);

    // The whole point: this used to throw "Invalid transition: PARENT_MESSAGE
    // from phase adult_chat", so every message in the endgame errored.
    const result = await engine.handleParentMessage(
      state,
      "parent1",
      "ADULT are you going to take it?"
    );

    expect(result.state.phase).toBe("adult_chat");
    expect(result.kidResponse).toBe("I've been thinking about it too.");

    const tail = result.state.messages.slice(-2);
    expect(tail[0]).toMatchObject({ sender: "parent1", content: "ADULT are you going to take it?" });
    expect(tail[1]).toMatchObject({ sender: "kid", content: "I've been thinking about it too." });
    // Both belong to the adult scene, not the last childhood one.
    expect(tail[0].eventNumber).toBe(result.state.currentEventNumber);
    expect(tail[1].eventNumber).toBe(result.state.currentEventNumber);
    // Routed to the adult Kid model, not the family-chat one.
    expect(mock.roleCalls.at(-1)).toBe("kid_adult_chat");
  });

  it("stamps adult messages as a shared chat the parents and the child can all see", async () => {
    const mock = new MockLLMClient();
    const state = await inAdultChat(mock);
    const engine = new ConversationEngine(mock);

    const { state: next } = await engine.handleParentMessage(state, "parent2", "ADULT tell me about it.");
    const parentMsg = next.messages.at(-2)!;

    expect(parentMsg.chatType).toBe("shared");
    expect(parentMsg.visibleTo).toEqual(["parent1", "parent2", "kid"]);
  });

  it("the transcript filter isolates the adult conversation from the last childhood scene", async () => {
    const mock = new MockLLMClient();
    mock.kidResponses = ["ADULT it's a big move."];
    const state = await inAdultChat(mock);
    const engine = new ConversationEngine(mock);
    const { state: next } = await engine.handleParentMessage(state, "parent1", "ADULT are you going to take it?");

    // What both clients now render (they filter on eventNumber + chatType).
    const rendered = next.messages
      .filter((m) => m.eventNumber === next.currentEventNumber && m.chatType !== "debrief")
      .map((m) => m.content)
      .join("\n");

    expect(rendered).toContain("ADULT");
    expect(rendered).not.toContain("CHILDHOOD");
  });

  it("applies the per-scene message cap, then refuses further messages", async () => {
    const mock = new MockLLMClient();
    let state = await inAdultChat(mock);
    const engine = new ConversationEngine(mock);

    expect(state.parentMessageCount).toBe(0);
    for (let i = 0; i < PARENT_MESSAGE_CAP; i++) {
      state = (await engine.handleParentMessage(state, "parent1", `turn ${i}`)).state;
    }

    expect(state.parentMessageCount).toBe(PARENT_MESSAGE_CAP);
    expect(
      canTransition(state, { type: "PARENT_MESSAGE", sender: "parent1", content: "one more" })
    ).toBe(false);
  });

  it("never runs the mid-scene scene-safety classifier — that check is family_chat only", async () => {
    // Deliberate and documented, not an oversight: classifyScene's tiers are
    // calibrated for a minor ("sexualization of the child"; dark PARENTING), so
    // running it over an adult-to-adult conversation would misfire. The
    // per-message OpenAI check is what covers this phase.
    const mock = new MockLLMClient();
    mock.groomingResult = { tier: "block", reason: "would fire if it were consulted" };
    let state = await inAdultChat(mock);
    const engine = new ConversationEngine(mock);

    let last!: Awaited<ReturnType<typeof engine.handleParentMessage>>;
    for (let i = 0; i < 8; i++) {
      last = await engine.handleParentMessage(state, "parent1", `turn ${i}`);
      state = last.state;
    }

    expect(last.sceneSafety).toBeUndefined();
    expect(mock.roleCalls).not.toContain("safety_check");
  });

  it("survives rehydration: parentMessageCount counts the adult scene only", async () => {
    const mock = new MockLLMClient();
    let state = await inAdultChat(mock);
    const engine = new ConversationEngine(mock);
    state = (await engine.handleParentMessage(state, "parent1", "ADULT one")).state;
    state = (await engine.handleParentMessage(state, "parent1", "ADULT two")).state;

    const repo = new InMemoryGameRepository();
    // Exactly what the ADULT_CHAT socket handler / REST route persist.
    for (const e of state.events) await repo.saveEvent(state.id, e);
    await repo.saveGame(state);
    for (const m of state.messages) await repo.saveMessage(state.id, m);

    const rehydrated = (await repo.loadGame(state.id))!;

    expect(rehydrated.phase).toBe("adult_chat");
    // 2, not 3 — the childhood parent message belongs to an earlier event and
    // must not eat the adult conversation's budget.
    expect(rehydrated.parentMessageCount).toBe(2);
    // The adult scenario resolves back as the current event, so the scene the
    // player is in survives a reload / device handoff.
    expect(rehydrated.currentEvent?.description).toBe(SCENARIO);
  });
});

describe("the adult_chat exit control", () => {
  it("SHOW_REPORT_CARD is a legal transition from adult_chat", async () => {
    const mock = new MockLLMClient();
    const state = await inAdultChat(mock);

    // Previously false — which is why "finish → report card" was a dead
    // control: the client called endChat, the server returned on its
    // `phase !== "family_chat"` guard, and nothing was broadcast.
    expect(canTransition(state, { type: "SHOW_REPORT_CARD", reportCard: "x" })).toBe(true);
  });

  it("generateReportCard advances adult_chat straight to the report card", async () => {
    const mock = new MockLLMClient();
    mock.identityUpdates = ["They grew up thoughtful.", "# Luna\n## Personality\nSteady."];
    const state = await inAdultChat(mock);
    const endgame = new EndgameEngine(mock);

    const result = await endgame.generateReportCard(state, "epilogue text");

    expect(result.state.phase).toBe("report_card");
    expect(result.reportCard).toContain("# Luna");
  });
});
