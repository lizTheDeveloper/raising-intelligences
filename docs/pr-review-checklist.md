# PR Review Checklist

Patterns that have blocked every client-side PR to date. Check these before requesting review.

## 1. `nextEvent` stale `gameId` closure

**What breaks:** `nextEvent` captures `gameId` from React state via `useCallback([gameId])`. If called in the same render that called `setGameId(...)` (e.g. right after `createGame`), `gameId` is still `null` in the closure → the function early-returns → the first event never loads → GuardianScreen "I'm ready" button is permanently disabled.

**Required pattern in `useGame.ts`:**
```ts
const nextEvent = useCallback(async (id?: string) => {
  const gid = id ?? gameId;
  if (!gid) return;
  // use gid everywhere, not gameId
}, [gameId]);
```

**Required pattern in `SoloGame.tsx` `handleStart`:**
```ts
const id = await createGame(nameInput.trim());
if (!id) return;           // createGame failed — stop here, error already set
await nextEvent(id);       // pass id directly, don't rely on state having flushed
```

## 2. `createGame` missing `res.ok` guard

**What breaks:** Without a response check, a server error causes `await res.json()` to throw or return garbage. `setGameId(undefined)` + `setPhase("event_intro")` are called on bad data → GuardianScreen renders → `ChildPortrait` can't load → `portraitReady` never fires → "I'm ready" button is disabled forever with no error shown.

**Required pattern in `useGame.ts` `createGame`:**
```ts
if (!res.ok) {
  const body = await res.text().catch(() => "");
  setError(`Failed to create game: ${res.status}${body ? ` — ${body}` : ""}`);
  return;   // return undefined → handleStart checks `if (!id) return`
}
```

## 3. `setShowGuardian(true)` must come AFTER `createGame` succeeds

**What breaks:** Setting UI state before the async call completes means a failed `createGame` leaves the user on GuardianScreen with no error and no exit.

**Required ordering in `handleStart`:**
```ts
const id = await createGame(...);  // 1. create first
if (!id) return;                   // 2. bail on failure
setShowGuardian(true);             // 3. only then advance UI
await nextEvent(id);               // 4. pass id — don't rely on gameId state
```

## 4. GuardianScreen must be preserved

Main has `showGuardian` state and a `<GuardianScreen>` render branch in `SoloGame.tsx`. PRs must not remove these. Verify the diff preserves:
- `const [showGuardian, setShowGuardian] = useState(false);`
- The `if (showGuardian && ...)` render branch
- The `eventReady={phase === "event_intro" && !loadingEvent}` prop

## 5. `model-config.ts` standard tier must use `qwen/qwen3.7-max` for quality roles

`server/src/llm/model-config.ts` — `psychologist`, `epilogue`, `report_card` must stay on `"qwen/qwen3.7-max"` in the standard tier. Any PR that changes these to `qwen/qwen3.7-plus` will break the test suite.

## 6. Relationship selector removal must be explicit

Several PRs have silently removed the relationship-type `<select>` from the start screen and hardcoded `"co-parents"`. If this is intentional, call it out explicitly in the PR description and update the relevant issue.

---

## Quick diff checklist

When reviewing a PR diff, grep for these before approving:

```bash
# Blocker 1 — nextEvent must have an id param
grep -n "nextEvent" client/src/hooks/useGame.ts
# Should show: async (id?: string) => { const gid = id ?? gameId

# Blocker 2 — createGame must check res.ok
grep -A3 "createGame" client/src/hooks/useGame.ts | grep "res.ok"
# Should return a match

# Blocker 3 — handleStart must pass the id
grep -A5 "handleStart" client/src/components/SoloGame.tsx
# Should show: const id = await createGame(...); if (!id) return; await nextEvent(id);
```
