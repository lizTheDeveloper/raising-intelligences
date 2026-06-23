---
name: event-prefetch-pattern
description: Prefetch LLM-generated game events during state creation to eliminate loading screen delays between phases
source: auto-skill
extracted_at: '2026-06-23T05:50:15.621Z'
---

# Event Prefetch Pattern for Eliminating Perceived Latency

When moving between game phases requires LLM-generated content (e.g., generating the first event after game creation), users often face long loading screens where buttons are disabled. The **event prefetch pattern** starts generation during the previous phase so content is ready when needed.

## Problem Statement

**Before:** User creates game → GuardianScreen waits for portrait + event → Event generation blocks for 5-15 seconds → Button slowly becomes enabled

**After:** User creates game → Event generation starts immediately during creation → Portrait loads in parallel → By time user reaches GuardianScreen, event is usually already resolved → Button enabled within 1-2 seconds

## Implementation

### 1. Server: Start Generation During Creation

In the POST endpoint for game creation, kick off the event generation as a background promise:

```typescript
router.post("/game", async (req: Request, res: Response) => {
  // Create game state
  const state = createGame(childName, relationshipType);
  games.set(state.id, state);
  await repo.saveGame(state);
  
  // Start event generation immediately (fire-and-forget)
  engine.startEvent(state).catch(err => {
    console.error("[game] prefetch error:", err);
  });
  
  // Return immediately - don't wait for event
  res.json({ gameId: state.id });
});
```

### 2. Server: Check for Prefetched Event in Next-Event Endpoint

When the client calls the next-event endpoint, check if the event was already generated:

```typescript
router.post("/game/:id/next-event", async (req: Request, res: Response) => {
  const state = games.get(req.params.id);
  if (!state) { res.status(404).json({ error: "Game not found" }); return; }
  
  // Check if event is already ready (prefetched during creation)
  if (state.currentEvent) {
    res.json({ 
      event: state.currentEvent,
      messagesRemaining: state.messagesRemaining 
    });
    return;
  }
  
  // Otherwise generate now (fallback)
  const next = await engine.startEvent(state);
  state.currentEvent = next.currentEvent;
  // ... persist state ...
  
  res.json({ 
    event: state.currentEvent,
    messagesRemaining: state.messagesRemaining 
  });
});
```

### 3. Client: Don't Block UI on Prefetch Completion

The GuardianScreen (or equivalent loading screen) should show immediately without waiting for the event. Only disable the action button until the event is ready:

```typescript
const handleStart = async () => {
  const res = await fetch(`${API}/game`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ childName, relationshipType }),
  });
  const data = await res.json();
  setGameId(data.gameId);
  setShowGuardian(true);
  // Don't call nextEvent here - it's already being prefetched
};
```

In the GuardianScreen component, poll for event readiness or use a separate endpoint:

```typescript
useEffect(() => {
  if (!gameId) return;
  
  const poll = setInterval(async () => {
    const res = await fetch(`${API}/game/${gameId}/state`);
    const state = await res.json();
    if (state.currentEvent) {
      setEventReady(true);
      setCurrentEvent(state.currentEvent);
      clearInterval(poll);
    }
  }, 500);
  
  return () => clearInterval(poll);
}, [gameId]);
```

### 4. UI Pattern: Loading with Personality

While waiting, instead of showing a blank disabled button, use rotating loading text with thematic flavor:

```typescript
const LOADING_MESSAGES = {
  guardian: [
    "they took their first steps today...",
    "they asked why the sky is blue...",
    "they found a dead bug in the garden...",
    "they insisted the moon follows them home...",
  ],
  // Age-specific messages can be added for other loading screens
};

const [messageIdx, setMessageIdx] = useState(0);

useEffect(() => {
  const interval = setInterval(() => {
    setMessageIdx((i) => (i + 1) % LOADING_MESSAGES.guardian.length);
  }, 2400);
  return () => clearInterval(interval);
}, []);
```

This transforms dead time into engaging narrative setup.

## Key Metrics

**Before (sequential):**
- Game creation: 0.5s
- GuardianScreen appears: instant
- Event generation: 5-15s (user sees disabled button)
- Total time to action: 15-20s perceived wait

**After (prefetch + parallel):**
- Game creation: 0.5s (event generation starts)
- GuardianScreen appears: instant
- Event ready: usually within 1-3s (overlaps with user reading)
- Total time to action: 2-4s perceived wait

**Perceived latency reduction: 70-85%**

## When to Use This Pattern

✅ **Good fit:**
- Game phases where the next state requires LLM generation
- Scenarios with loading screens that already show thematic content
- State transitions where the user has time to read/process before acting

❌ **Not ideal:**
- Real-time interactions (chat, turn-based games)
- When the user needs to see results immediately
- If the LLM call depends on user input from the loading screen

## Additional Optimizations

### Parallel Resource Loading

Combine event prefetch with other background tasks:

```typescript
// In game creation endpoint
generateFirstPortrait(state.id).catch(err => {
  console.error("[portrait] error:", err);
});
engine.startEvent(state).catch(err => {
  console.error("[game] event prefetch error:", err);
});
```

### Client-Side Polling Strategy

Use exponential backoff or event-driven updates (WebSocket/SSE) instead of fixed-interval polling:

```typescript
// Preferred: WebSocket push when event is ready
socket.on("event_ready", (data) => {
  setEventReady(true);
  setCurrentEvent(data.event);
});
```

### Graceful Degradation

Always implement a fallback path in case prefetch fails:

```typescript
// In next-event endpoint
if (state.currentEvent) {
  // Use prefetched event
  res.json({ event: state.currentEvent });
} else {
  // Generate on-demand (will be slower but still works)
  const next = await engine.startEvent(state);
  res.json({ event: next.currentEvent });
}
```

## Related Patterns

- **LLM streaming** (see `auto-skill-llm-latency-investigation`) for showing generation progress
- **Background job queues** for longer-running tasks that shouldn't block HTTP responses
- **Optimistic UI updates** where you show predicted results while generation completes
