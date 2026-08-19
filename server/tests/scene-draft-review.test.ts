/**
 * The World Manager's floor, and the structural backstop for it.
 *
 * The defect these cover: the generator can stage a scene with the harmful act
 * already loaded into the parent's hands and an NPC urging its use, so a player
 * who follows the scene's own strongest affordance walks into the scene-level
 * classifier and loses their session. The prompt floor is the primary fix; this
 * is the guard for when the prompt does not hold.
 *
 * These tests must NOT be read as safety tests. The guard reviews *generated*
 * text only and fails open by design — the safety layer that judges the player
 * is moderation.ts / pattern-detection.ts, and nothing here touches it.
 */
import { describe, it, expect } from "vitest";
import { ConversationEngine } from "../src/game/conversation-engine.js";
import { createGame } from "../src/game/state-machine.js";
import { MockLLMClient } from "../src/llm/mock.js";
import {
  reviewSceneDraft,
  shouldReviewSceneDrafts,
  sceneRedraftNote,
  SCENE_DRAFT_REVIEW_SYSTEM_PROMPT,
} from "../src/safety/scene-draft-review.js";
import { WORLD_MANAGER_SYSTEM_PROMPT } from "../src/llm/prompts.js";
import type { GameEvent, GameState } from "../src/types.js";

const draftEvent = (n: number): GameEvent => ({
  eventNumber: n,
  age: 4 + n,
  description: `Draft ${n}. Your child is standing in the doorway.`,
  setting: "Kitchen",
  trigger: "A broken plate",
});

/** A mock whose safety_check role answers the draft reviewer, not classifyScene. */
function reviewerMock(verdict: unknown, events: GameEvent[]): MockLLMClient {
  const mock = new MockLLMClient();
  mock.events = [...events];
  mock.groomingResult = verdict as MockLLMClient["groomingResult"];
  return mock;
}

/** A game that has already gone dark — the only kind whose drafts get reviewed. */
function darkGame(): GameState {
  return { ...createGame("Luna"), concernLevel: 2 };
}

describe("World Manager floor (prompt)", () => {
  it("states the floor without withdrawing permission to be hard", () => {
    expect(WORLD_MANAGER_SYSTEM_PROMPT).toContain("## Where the floor is");
    // The game must stay willing to depict difficult parenting — the fix is a
    // floor, not a softening. If someone ever deletes the "nothing above is
    // being taken back" framing, this is the tripwire.
    expect(WORLD_MANAGER_SYSTEM_PROMPT).toContain("Nothing above is being taken back");
    expect(WORLD_MANAGER_SYSTEM_PROMPT).toContain("Sometimes unwinnable");
  });

  it("distinguishes a situation where harm is possible from harm already underway", () => {
    expect(WORLD_MANAGER_SYSTEM_PROMPT).toContain("Nobody is mid-strike when your scene opens");
    expect(WORLD_MANAGER_SYSTEM_PROMPT).toContain("the only thing left to do");
    // The exhibit: instrument pre-loaded AND socially urged AND no other door.
    expect(WORLD_MANAGER_SYSTEM_PROMPT).toContain("it's a ramp");
  });

  it("keeps 'unwinnable' meaning no good answer, not a foregone one", () => {
    expect(WORLD_MANAGER_SYSTEM_PROMPT).toContain(
      "Unwinnable means there's no good answer left, not that the bad one has already been given"
    );
  });
});

describe("reviewSceneDraft", () => {
  it("passes a draft the reviewer approves", async () => {
    const mock = reviewerMock({ ok: true, reason: "" }, []);
    const review = await reviewSceneDraft(mock, draftEvent(1));
    expect(review.ok).toBe(true);
  });

  it("rejects only on an explicit false, carrying the reason", async () => {
    const mock = reviewerMock({ ok: false, reason: "the belt is already swinging" }, []);
    const review = await reviewSceneDraft(mock, draftEvent(1));
    expect(review).toEqual({ ok: false, reason: "the belt is already swinging" });
  });

  it("fails OPEN on a garbled verdict — a craft guard must never brick generation", async () => {
    const mock = reviewerMock({ verdict: "nope" }, []);
    expect((await reviewSceneDraft(mock, draftEvent(1))).ok).toBe(true);
  });

  it("fails OPEN when the reviewer throws", async () => {
    const mock = reviewerMock({ ok: false, reason: "x" }, []);
    mock.throwOnSafetyCheck = true;
    const review = await reviewSceneDraft(mock, draftEvent(1));
    expect(review.ok).toBe(true);
    expect(review.reason).toBe("scene_draft_review_unavailable");
  });

  it("shows the reviewer the scene text, and tells it not to soften the game", () => {
    expect(SCENE_DRAFT_REVIEW_SYSTEM_PROMPT).toContain("You are not here to soften the game");
    expect(SCENE_DRAFT_REVIEW_SYSTEM_PROMPT).toContain("A relative URGING physical punishment passes");
    expect(SCENE_DRAFT_REVIEW_SYSTEM_PROMPT).toContain("When you are unsure, pass");
  });

  it("the redraft note asks for a different scene, not a gentler one", () => {
    const note = sceneRedraftNote("the belt is already swinging");
    expect(note).toContain("Keep the pressure");
    expect(note).toContain("the belt is already swinging");
  });
});

describe("shouldReviewSceneDrafts", () => {
  it("is off for a game that has never gone dark", () => {
    expect(shouldReviewSceneDrafts({ concernLevel: 0, highestRungFired: 0 })).toBe(false);
  });

  it("is on once concern has accrued", () => {
    expect(shouldReviewSceneDrafts({ concernLevel: 1, highestRungFired: 0 })).toBe(true);
  });

  it("is on once the intervention ladder has fired, even after concern decayed away", () => {
    expect(shouldReviewSceneDrafts({ concernLevel: 0, highestRungFired: 1 })).toBe(true);
  });
});

describe("scene generation with the backstop", () => {
  it("does not review drafts — or spend a call — on an ordinary game", async () => {
    const mock = reviewerMock({ ok: false, reason: "would reject if consulted" }, [draftEvent(1)]);
    const engine = new ConversationEngine(mock);
    const next = await engine.startEvent(createGame("Luna"));

    expect(next.currentEvent?.description).toContain("Draft 1");
    expect(mock.roleCalls).toEqual(["world_manager"]);
  });

  it("reviews and ships the first draft when it clears the floor", async () => {
    const mock = reviewerMock({ ok: true, reason: "" }, [draftEvent(1), draftEvent(2)]);
    const engine = new ConversationEngine(mock);
    const next = await engine.startEvent(darkGame());

    expect(next.currentEvent?.description).toContain("Draft 1");
    expect(mock.roleCalls).toEqual(["world_manager", "safety_check"]);
  });

  it("RETRIES: a rejected draft is regenerated, and the redraft is what the player gets", async () => {
    const mock = new MockLLMClient();
    mock.events = [draftEvent(1), draftEvent(2)];
    // Reject the first draft, pass the second.
    let seen = 0;
    const verdicts = [
      { ok: false, reason: "the belt is already in their hand" },
      { ok: true, reason: "" },
    ];
    const inner = mock.completeJson.bind(mock);
    mock.completeJson = async <T,>(system: string, user: string, role?: never): Promise<T> => {
      if (role === ("safety_check" as never)) {
        mock.roleCalls.push(role);
        return verdicts[Math.min(seen++, verdicts.length - 1)] as unknown as T;
      }
      return inner<T>(system, user, role);
    };

    const engine = new ConversationEngine(mock);
    const next = await engine.startEvent(darkGame());

    expect(next.currentEvent?.description).toContain("Draft 2");
    expect(mock.roleCalls).toEqual([
      "world_manager",
      "safety_check",
      "world_manager",
      "safety_check",
    ]);
  });

  it("CANNOT LOOP: a reviewer that rejects everything stops after a fixed number of drafts", async () => {
    // Ten events available, so nothing but the bound itself can stop the loop.
    const events = Array.from({ length: 10 }, (_, i) => draftEvent(i + 1));
    const mock = reviewerMock({ ok: false, reason: "always rejects" }, events);
    const engine = new ConversationEngine(mock);

    const next = await engine.startEvent(darkGame());

    const worldManagerCalls = mock.roleCalls.filter((r) => r === "world_manager").length;
    expect(worldManagerCalls).toBe(2);
    // And the game still gets a scene rather than a dead session.
    expect(next.phase).toBe("family_chat");
    expect(next.currentEvent?.description).toContain("Draft 2");
  });

  it("applies to the prefetch path too, not just the blocking one", async () => {
    const mock = reviewerMock({ ok: true, reason: "" }, [draftEvent(1)]);
    const engine = new ConversationEngine(mock);

    await engine.prefetchNextEvent(darkGame());

    expect(mock.roleCalls).toEqual(["world_manager", "safety_check"]);
  });

  it("still throws on a malformed world-manager response rather than redrafting it", async () => {
    const mock = reviewerMock({ ok: true, reason: "" }, []);
    mock.events = [{ ...draftEvent(1), description: "" } as GameEvent];
    const engine = new ConversationEngine(mock);

    await expect(engine.startEvent(darkGame())).rejects.toThrow(/missing description/);
  });
});
