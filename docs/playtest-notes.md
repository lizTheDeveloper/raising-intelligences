# Raising Intelligences — playtest notes

Running log of playtest feedback. Newest session first. Each item records the
verbatim observation, the code anchor, and (where known) the constraint that
makes it non-trivial. These are notes, not tickets — nothing here has been
implemented.

---

## 2026-07-31 — partner play (Liz, 2-player)

### 1. Too many "ready up" gates

> "You shouldn't have to ready up to take the quiz or do the confession.
> There's too many 'ready up' moments — try to reduce gates."

Every gate below funnels through the single `E.READY` handler in
`server/src/socket/handlers.ts:346`. Inventory, classified by whether the gated
action is **per-player** (each player can proceed independently — safe to
un-gate) or a **shared phase transition** (both clients must land in the same
phase — this is what `server/tests/ready-race.test.ts` guards):

| # | Gate | Phase branch | Kind | Notes |
|---|------|--------------|------|-------|
| 1 | Lobby "ready" | pre-`event_intro` | shared | `client/src/components/Lobby.tsx:25`. Legitimate — both players must be present before the game exists. |
| 2 | OCEAN quiz + confessional | `GuardianScreen` | **per-player** | `client/src/components/GuardianScreen.tsx` — `QUIZ_QUESTIONS` (5 items) then `{ kind: "confessional" }`, ending in a `"waiting"` step. Each parent's personality seed is independent (`submitPersonality`). **This is the one Liz called out — no synchronization reason for it to be gated.** |
| 3 | `event_intro` → `family_chat` | `handlers.ts:369` | shared | Also triggers `loadEvent()` (~20s LLM). Already collapsed from two ready-rounds to one after 9/13 games stranded in `event_intro`; see comment at `handlers.ts:371-375`. |
| 4 | `debrief` → next chapter | `handlers.ts:398` | shared | Rendered as `ReadyToggle label="next chapter"` at `MultiplayerGame.tsx:512`. |
| 5 | `consult` → continue | `handlers.ts:440` | shared | Dark Play rung 1. `MultiplayerGame.tsx:410` — the screen's own "continue" sets ready, *then* swaps to a ReadyToggle waiting view. Two-step feel. |
| 6 | `therapy` → continue | `handlers.ts:447` | shared | Rung 2, same pattern. |
| 7 | `cps_review` → continue | `handlers.ts:454` | shared | Rung 3, same pattern. |

**Discriminator for the fix:** gate #2 is per-player and should be un-gated
outright — a parent should be able to start the quiz the moment they land on
the Guardian screen, and the "waiting" step at the end already covers the
synchronization. Gates #3–#7 are genuine two-player barriers, but #5–#7 present
*two* interactions where one would do (screen's continue button → ReadyToggle),
which is likely part of why it reads as "too many."

### 2. "Not yet" / "ready" must be clicked twice

> "I keep having to click 'not yet' and 'ready' twice."

**Likely cause — client/server ready state are two different sources of truth.**
`ReadyToggle` (`client/src/components/MultiplayerGame.tsx:548`) renders from the
local `ready` prop, which is `gateReady` — React state in `MultiplayerGame`. The
server clears its own flags via `resetReady` on *every* successful advance
(`handlers.ts:363`), but the client only clears `gateReady` when
`currentEventNumber` changes (`MultiplayerGame.tsx:132-139`).

So on any advance where the event number does *not* change, `gateReady` stays
`true` while the server has already reset to `false`. The UI shows "you're ready
/ not yet"; the first click ("not yet") only re-syncs local state and emits a
no-op `ready(false)`; the second click is the one the server actually registers.

**This fires on every chapter, not just edge cases.** `currentEventNumber` is
incremented only by `LOAD_EVENT` and `START_EVENT` (`state-machine.ts:171,187`).
`END_DEBRIEF` (`state-machine.ts:270`) changes the phase to `event_intro` and
sets `currentEvent: null` but does **not** touch `currentEventNumber` — the
increment doesn't happen until the *next* ready fires `loadEvent()`. So the
normal per-chapter sequence is:

1. debrief — player clicks "next chapter", `gateReady = true`
2. both ready → server `resetReady()` (server ready = `false`) → `END_DEBRIEF`
3. client lands on `event_intro`; `currentEventNumber` unchanged, so the reset
   effect never runs and `gateReady` is still `true`
4. player sees "you're ready / not yet" on a gate they have not actually passed

The Dark Play ladder reroutes (`debrief` → `consult`/`therapy`/`cps_review`) hit
the same drift via `ladderReady`, but they are an additional case, not the cause.

`Lobby.tsx` gets this right and `MultiplayerGame.tsx` does not:

```ts
// Lobby.tsx:20 — derived from server state
const ready = me?.ready ?? false;

// MultiplayerGame.tsx:39 — local duplicate that can drift
const [gateReady, setGateReady] = useState(false);
```

**Suggested direction:** delete `gateReady` / `ladderReady` and derive ready from
`mp.players.find(p => p.slot === mp.slot)?.ready`, matching Lobby. That removes
the drift class entirely rather than adding another reset effect.

### 3. Debrief should not wait on scene evaluation or scene generation

> "Parents should go straight into the debrief while the scene generator
> evaluates and the new scene is generated — reduce player waiting."

There are currently **two serial LLM waits** per scene in multiplayer:

1. **`family_chat` → `processing` → `debrief`.** `endChat` (`handlers.ts:145`)
   awaits `conversationEngine.endFamilyChat()` — the psychologist/identity-document
   pass. Phase only becomes `debrief` via `IDENTITY_UPDATED`
   (`state-machine.ts:257`), i.e. *after* the evaluator finishes. Players sit on
   `ProcessingScreen` for the whole call.
2. **`debrief` → `event_intro` → `family_chat`.** On ready, `handlers.ts:379`
   awaits `conversationEngine.loadEvent(state)` while the client shows
   "building the next scene…" (`MultiplayerGame.tsx:310`).

**The prefetch already exists — it is just not wired into multiplayer.**
`conversationEngine.prefetchNextEvent()` / `applyPrefetchedEvent()`
(`conversation-engine.ts:197,204`) are called *only* from `server/src/routes/game.ts`
(lines 99, 142-147, 298) — the solo/HTTP path. `socket/handlers.ts` contains no
prefetch call at all. Porting the solo path's `prefetchedEvents` map to the socket
handlers kills wait #2 outright.

For wait #1: the multiplayer debrief screen is **static text** — "later that
night / the kids are asleep. it's just you two." plus the ReadyToggle
(`MultiplayerGame.tsx:500-520`). It does not consume the evaluator's output, so
there is no content dependency blocking an early transition into `debrief`. The
coupling is purely structural: `IDENTITY_UPDATED` is what sets the phase. That
suggests splitting the transition (enter `debrief` on `END_FAMILY_CHAT`, apply
the identity document when it lands) rather than reordering.

**Open question to resolve before implementing:** the psychologist document
streams to clients via `DOC_CHUNK` during `processing`. If any downstream screen
or the report card assumes the document has fully landed by the time `debrief`
is entered, decoupling needs a guard. `ProcessingScreen` and the `DOC_DONE`
handling at `handlers.ts:420` are the places to check.

**Note:** the `ProcessingScreen` fragment lines are good writing and shouldn't be
thrown away with the wait — worth considering whether they move into the debrief
beat rather than disappearing.
