import { describe, it, expect } from "vitest";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { createGame } from "../src/game/state-machine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import type { GameEvent, GameState } from "../src/types.js";

// The model's JSON carries an eventNumber it was only asked to echo. These
// tests hand the engine WRONG ones and check the server's counter wins, because
// message filtering and research answer rows both key on it.
function wrongEvent(eventNumber: number): GameEvent {
  return { eventNumber, age: 5, description: "A quiet afternoon.", setting: "Kitchen", trigger: "Spilled milk" };
}

function between(state: GameState): GameState {
  return { ...state, phase: "event_intro", currentEvent: null };
}

describe("server-stamped event numbers", () => {
  it.each([0, 999])("first scene (model said %i) is stamped 1", async (wrong) => {
    const mock = new MockLLMClient();
    mock.events = [wrongEvent(wrong)];
    const next = await new ConversationEngine(mock).startEvent(createGame("Luna"));
    expect(next.currentEventNumber).toBe(1);
    expect(next.currentEvent?.eventNumber).toBe(1);
    expect(next.events.map((e) => e.eventNumber)).toEqual([1]);
  });

  it.each([0, 999])("a later scene (model said %i) is stamped from the counter", async (wrong) => {
    const mock = new MockLLMClient();
    mock.events = [wrongEvent(wrong), wrongEvent(wrong), wrongEvent(wrong)];
    const engine = new ConversationEngine(mock);
    let state = await engine.startEvent(createGame("Luna"));
    state = await engine.startEvent(between(state));
    state = await engine.startEvent(between(state));
    expect(state.currentEventNumber).toBe(3);
    expect(state.currentEvent?.eventNumber).toBe(3);
    expect(state.events.map((e) => e.eventNumber)).toEqual([1, 2, 3]);
  });

  it.each([0, 999])("loadEvent (model said %i) is stamped", async (wrong) => {
    const mock = new MockLLMClient();
    mock.events = [wrongEvent(wrong)];
    const state = await new ConversationEngine(mock).loadEvent(
      { ...createGame("Luna"), currentEventNumber: 4 },
    );
    expect(state.currentEvent?.eventNumber).toBe(5);
    expect(state.currentEventNumber).toBe(5);
  });

  it.each([0, 999])("a prefetched scene (model said %i) is stamped when applied", async (wrong) => {
    const mock = new MockLLMClient();
    mock.events = [wrongEvent(wrong), wrongEvent(wrong)];
    const engine = new ConversationEngine(mock);
    const scene1 = await engine.startEvent(createGame("Luna"));
    // Prefetch runs against the pre-scene-end state, while scene 1 is current.
    const prefetched = await engine.prefetchNextEvent(scene1);
    const applied = engine.applyPrefetchedEvent(between(scene1), prefetched);
    expect(applied.currentEventNumber).toBe(2);
    expect(applied.currentEvent?.eventNumber).toBe(2);
    expect(applied.events.map((e) => e.eventNumber)).toEqual([1, 2]);
  });
});
