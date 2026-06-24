# Conversation Flow Redesign

## The Question

How does a player know when they're supposed to end the conversation?

## Current Behavior

Player clicks "end conversation" whenever they feel like it. There's a 12-message cap (combined across both parents) but hitting it doesn't end the scene — it just disables the send button. The player still has to manually click "end conversation."

The observed play pattern: "once I've redirected the kid through this difficult moment, I click end conversation." This is correct — the game is about navigating parenting moments, not simulating an entire day. Each event is a scene with a dramatic question: how do you handle this? Once the player has handled it (well or badly), the scene should end.

## Problem

There's no signal from the game that the moment has resolved. The player is doing meta-game work (deciding when the scene is "done") that should be the game's job. This is like a tabletop RPG where the GM never calls scene — the players just awkwardly trail off.

## Proposal: Natural Scene Resolution

The kid AI should resolve scenes organically. After the parenting moment has played out — kid accepted it, kid stormed off, kid shut down, situation escalated beyond repair — the kid's response should include a natural scene-ending action. The game detects this and auto-transitions.

### How It Works

1. **Kid response includes a scene-ending marker.** The kid prompt gets a new instruction: when the moment has reached a natural conclusion (resolved, escalated, or stalled), end your response with a narrative action that closes the scene. Examples:
   - "Fine." She picks up her backpack and walks to the car without looking at you.
   - He nods slowly, then goes back to his homework. The kitchen is quiet.
   - She slams her door. You hear music start playing, loud.
   - "Okay, mom." He reaches for your hand.

2. **Server detects scene closure.** After each kid response, the server checks: has the kid ended the scene? This could be:
   - A structured flag in the kid's response (add `sceneOver: true` to the JSON)
   - A second LLM call (cheap/fast) that reads the last exchange and returns whether the scene has concluded
   - Heuristic: if the kid's response contains a physical departure action (walks away, goes to room, leaves)

3. **Auto-transition to processing.** When scene closure is detected, the game auto-triggers END_CHAT. No button needed. The "end conversation" button stays as an escape hatch (renamed "leave the room" or "walk away") but the normal flow is the scene ending itself.

4. **Message cap becomes a hard scene limit.** When the cap is reached, the kid automatically delivers a closing response and the scene ends. No awkward disabled-button state.

### Kid Prompt Changes

Add to the kid system prompt:

```
## Scene pacing

You are playing a specific moment, not an entire day. The scene has a natural arc:
- It starts with a trigger (the event description)
- The parent(s) respond
- You react authentically based on who you are
- The moment either resolves, escalates, or stalls

When the moment has reached its natural conclusion — you've accepted what they said, you've stormed off, you've shut down, the situation has played out — end your response with a physical action that closes the scene. Walk away, go to your room, go back to what you were doing, reach for their hand. Let the scene breathe and then end.

Don't drag scenes out. Real parenting moments are short. 3-6 exchanges is a full scene. If the parent keeps pushing after you've resolved, you can gently close: "okay, mom" and go back to playing. If they keep lecturing, you zone out or leave.

If you're at message {currentCount} of {maxMessages}, this is your last response. End the scene definitively — give the moment a landing.
```

### Scene Closure Detection

The recommended approach: structured output from the kid AI.

Instead of free-text only, the kid response becomes:

```json
{
  "response": "Fine. She picks up her backpack and walks to the car.",
  "sceneOver": true
}
```

The server checks `sceneOver` after each kid response. If true, auto-trigger END_CHAT after a brief pause (2-3 seconds so the player can read the final response).

Fallback: if structured output is too complex for streaming, append a sentinel token (`[SCENE_END]`) that the server strips before displaying.

## Debrief: Later That Night

After the scene ends, the game transitions to the debrief. This is the end-of-day moment — the kids are asleep, it's just the parents.

### Current
- Processing screen (psychologist generates identity doc)
- "a moment between you two / what just happened?"
- Ready gate, then next chapter

### Proposed
- Processing screen stays (identity doc generation)
- Debrief becomes **"later that night"** — a brief reflection moment
- In multiplayer: this is the parents' private time. They could have an actual conversation here (text each other in-game, no kid AI). Or it stays as a contemplative pause. TBD based on playtesting.
- Ready gate label: "next chapter" (already deployed)
- No "end childhood" button (already removed) — epilogue auto-triggers after the last event

## Follow-up Conversations with Other Adults

### The Idea

The world manager already generates recurring characters (Nana, the teacher, the ex, the friend with one parenting book). But players can't interact with them directly. Some of the most important parenting work happens in conversations with OTHER adults about what just happened — calling your sister to vent about what Nana said, talking to the teacher after the incident, texting your friend for advice.

### How It Would Work

After the main scene ends (kid walks away, scene resolves), before the debrief:

1. **The game shows who was involved.** "Nana was there today." / "Ms. Rivera wants to talk after class."
2. **Optional follow-up.** Each parent can choose to have a brief follow-up conversation with one of the adults from the scene. This is a 3-4 exchange sidebar — not a full scene.
3. **The adult has their own personality and agenda.** Nana doubles down on her advice. The teacher has concerns. The friend is supportive but slightly off-base. These are driven by the world manager's character descriptions.
4. **The conversation affects the world model.** How you handle Nana affects whether she shows up again, whether she escalates, whether your relationship improves. This gets tracked.

### Relationship Tracking

Add a `relationships` field to the game state that tracks the player's relationship with recurring characters:

```
relationships: {
  "Nana": {
    trust: 0.6,      // do they trust your parenting?
    tension: 0.4,    // how much friction exists?
    lastSeen: 3,     // event number
    notes: "disagreed about screen time, you held firm"
  },
  "Ms. Rivera": { ... }
}
```

The world manager sees this when generating events, so relationships evolve naturally. If you keep clashing with Nana, she might stop coming around — or escalate. If you build trust with the teacher, they might give you a heads-up before the next incident instead of an after-the-fact report.

### Implementation Phases

**Phase 1 (now):** Natural scene resolution. Kid ends scenes organically. Remove "end conversation" as the primary flow (keep as escape hatch).

**Phase 2:** Debrief as nighttime reflection. Processing screen -> "later that night" pause -> ready gate.

**Phase 3:** Follow-up conversations. After scene resolution, offer optional conversations with involved adults. Track relationships.

**Phase 4:** Relationship evolution. World manager uses relationship state to shape future events. Adults become more complex over time based on player interactions.

## Open Questions

- Should the debrief include an actual parent-to-parent conversation (in multiplayer)? Or is the pause enough?
- How many follow-up conversations per event? One per parent? One total?
- Should follow-up conversations affect the identity document? (Probably not directly — they affect the world, not the kid's inner life. Unless the kid overhears.)
- Does the "walk away" escape hatch need a confirmation? ("Are you sure? The moment isn't resolved yet.")
