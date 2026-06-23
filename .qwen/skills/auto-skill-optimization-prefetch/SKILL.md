---
name: optimization-prefetch
description: Reduce perceived wait times by prefetching data during user actions instead of on-demand
source: auto-skill
extracted_at: '2026-06-23T07:56:36.833Z'
---

# Optimization Pattern: Prefetch During User Actions

When users face wait times during interactive flows, move expensive operations to run *before* they're needed by starting them during earlier user actions.

## The Problem

User completes Form A → waits 5-10s for processing → sees result of Form B → waits 5-10s more → sees final result

The waits feel long because nothing is happening *during* them. The user is staring at a spinner.

## The Solution

Start the expensive work while the user is on Form A (or immediately after they submit it), so by the time they'd normally wait, the work is already done.

## Implementation Pattern

### 1. Identify Wait Points

```typescript
// Before: sequential waits
async function handleSubmit() {
  setLoading(true);
  const step1 = await expensiveOperation1(); // 5s wait
  const step2 = await expensiveOperation2(); // 5s wait
  setLoading(false);
  return { step1, step2 };
}
```

### 2. Prefetch During Earlier Actions

```typescript
// After: start work early
const pendingOperation = useRef<Promise<Result> | null>(null);

function handleFormA() {
  // Start expensive work immediately after form submission
  // (don't await it yet)
  pendingOperation.current = runExpensiveOperations();
  
  // Show UI immediately
  setPhase("processing");
}

async function handleAdvance() {
  // If prefetch exists, wait for it
  if (pendingOperation.current) {
    const result = await pendingOperation.current;
    pendingOperation.current = null;
    return result;
  }
  // Otherwise, do it now (fallback)
  return runExpensiveOperations();
}
```

### 3. Show Activity While Waiting

Don't stare at a spinner. Show rotating text, animations, or progress indicators:

```typescript
// Client: show rotating messages while waiting
const FRAGMENTS = [
  "they took their first steps.",
  "they said your name.",
  "they asked why things are the way they are.",
  // ...
];

useEffect(() => {
  if (!isLoading) return;
  const id = setInterval(() => {
    setFragmentIdx((i) => (i + 1) % FRAGMENTS.length);
  }, 7000);
  return () => clearInterval(id);
}, [isLoading]);

if (isLoading) {
  return (
    <div className="loading-screen">
      <p className="fragment">{FRAGMENTS[fragmentIdx]}</p>
    </div>
  );
}
```

## Server-Side Pattern

Store pending promises in a Map so they can be retrieved:

```typescript
// Server: maintain pending operations
const prefetchedEvents = new Map<string, Promise<GameState>>();

async function handleCreateGame(req: Request, res: Response) {
  const state = createGame(req.body);
  games.set(state.id, state);
  
  // Start expensive work but don't await
  const prefetched = engine.startEvent(state);
  prefetchedEvents.set(state.id, prefetched);
  
  // Respond immediately
  res.json({ gameId: state.id });
  // Portrait generation also runs in background
  generatePortrait(state.id).catch(() => {});
}

async function handleGetEvent(req: Request, res: Response) {
  const { gameId } = req.params;
  
  // Check if we have prefetch result
  const prefetched = prefetchedEvents.get(gameId);
  if (prefetched) {
    prefetchedEvents.delete(gameId);
    const result = await prefetched;
    res.json(result);
    return;
  }
  
  // Fallback: generate now
  const state = games.get(gameId);
  const event = await engine.startEvent(state);
  res.json(event);
}
```

## Key Benefits

1. **Perceived speed** - Work happens "during" user actions, not after
2. **No wasted time** - Operations overlap with user thinking time
3. **Graceful fallback** - If prefetch isn't used, generate on-demand
4. **Better UX** - Show activity/messages instead of blank loading

## When to Use

- Multi-step flows where step 2's data could be generated during step 1
- Forms that trigger expensive validation or data fetching
- Games with loading screens between phases
- Any workflow where users have "thinking time" between actions

## Example Timeline

**Before:**
```
User fills form (10s) → sees spinner (10s) → sees next form
```

**After:**
```
User fills form (10s) → [work runs in background during form] → sees next form immediately
```

## Pitfalls to Avoid

1. **Don't block user actions** - Start work but don't await it
2. **Don't show blank screens** - Show rotating messages, animations, or progress
3. **Always have a fallback** - What if prefetch wasn't triggered?
4. **Clean up pending work** - Delete prefetched data after it's used
5. **Handle errors gracefully** - If prefetch fails, regenerate on-demand

## Measurement

Track:
- Time between user actions and results
- How often prefetch succeeds vs. falls back to on-demand
- User engagement during loading screens (do they wait or leave?)
