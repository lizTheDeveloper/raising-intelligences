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

**CORRECTION (verified during implementation):** row #2 below was wrong in the
original write-up, and the framing sentence was over-broad. `GuardianScreen`
never emits `E.READY` — its `onReady` prop is a purely local overlay dismissal
(`MultiplayerGame.tsx:288` → `setGuardianDismissed(true)`;
`SoloGame.tsx:256` → `setShowGuardian(false)`), and `MultiplayerGame.tsx:122-124`
documents it as such. There is no pre-quiz or pre-confessional confirming click
in that component at all; entry to both is timer-driven. Rows #1 and #3–#7 were
re-verified against the source and do funnel through the single `E.READY`
handler at `server/src/socket/handlers.ts:346`. See the addendum below for what
the player was actually describing.

Inventory, classified by whether the gated action is **per-player** (each player
can proceed independently — safe to un-gate) or a **shared phase transition**
(both clients must land in the same phase — this is what
`server/tests/ready-race.test.ts` guards):

| # | Gate | Phase branch | Kind | Notes |
|---|------|--------------|------|-------|
| 1 | Lobby "ready" | pre-`event_intro` | shared | `client/src/components/Lobby.tsx:25`. Legitimate — both players must be present before the game exists. |
| 2 | ~~OCEAN quiz + confessional~~ | `GuardianScreen` | **not a ready gate** | Struck — see correction above. Local overlay dismissal, never emits `E.READY`. The real finding is in the addendum. |
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

#### Addendum to item 1 — what "ready up to take the quiz" actually refers to

Since there is no gate *inside* `GuardianScreen`, the gates the player hit are
the ones **before** it. `showGuardian` (`MultiplayerGame.tsx:125-130`) requires
`currentEventNumber === 1` **and `currentEvent !== null`** — so the quiz cannot
appear until scene 1 has finished generating. The actual opening sequence is:

1. lobby ready (gate #1)
2. `event_intro` ready (gate #3)
3. ~20s `loadEvent` wait — "building the next scene…"
4. *then* the OCEAN quiz and the confessional
5. terminal "I'm ready"

So: two ready gates and a full scene-generation wait stand between the player
and a questionnaire that needs neither. That matches the complaint exactly.

**This is also a latent content bug, not just pacing.** The personality seed
feeds the kid's temperament (`context-assembler.ts:140-141`) and is passed into
the world-manager context (`:412`), but it does not exist until *after* the quiz
— which is after scene 1 is already generated. **Scene 1 is currently built with
no personality seed and no parent personalities.** Moving the quiz ahead of
first-scene generation removes both ready gates and the wait *and* makes the
opening scene personality-informed for the first time.

**Approved direction (Liz, 2026-07-31): reorder the quiz ahead of scene 1.**

Note that "run the quiz concurrently with generation" is the *wrong* fix — it
removes the wait but leaves scene 1 personality-blind, which is the more
valuable half of the bug. The seed has to exist before the world manager runs.

Sequencing to build:

1. Lobby ready → **Guardian quiz immediately**, no `event_intro` gate, no scene
   generation yet. Drop the `currentEvent !== null` condition from
   `showGuardian` (`MultiplayerGame.tsx:125-130`) and the equivalent in
   `SoloGame.tsx`.
2. Both parents submit → `generatePersonalitySeed` runs as it does today
   (`handlers.ts:826-841`).
3. **Kick off scene-1 generation the moment `PERSONALITY_SEED_READY` fires**,
   not on a ready gate. The seed and both `parentPersonalities` are now in
   state, so the world manager finally sees them.
4. The generation wait is masked by content that already exists: the portrait
   reveal and the terminal "I'm ready" / "most people aren't" beat play over it.
   `canBegin = effectiveSeedReady && portraitRevealed` is already the right
   condition to hold on; it just needs to also await the event.

Net effect: one ready gate removed from the opening, ~20s of dead waiting
replaced by existing written content, and scene 1 becomes personality-informed
for the first time.

Deferred until the client-state pass lands, to avoid two agents editing
`MultiplayerGame.tsx` at once.

**Already shipped on this item:** ~14.9s of unskippable narrative pacing before
the quiz (1200+1600ms before Q1, then 2400+1600, 2400+1600, a 1600 transition
and a 2500 reveal) is now skippable via click or Enter/Space, with the skip
overlay deliberately not mounted on `quiz`, `confessional`, or `waiting` steps so
a stray click can never answer a question or jump the co-parent handshake. No
prose was removed. Required content clicks are unchanged at 6.

### 2. "Not yet" / "ready" must be clicked twice — and it can deadlock the game

> "I keep having to click 'not yet' and 'ready' twice."
> …later, in a live game: "we are desync'd it just says 1 of 2 ready for both
> of us" (game `8eda7ff3-19b9-4be7-8e74-7439df5441a0`)

**This is worse than a double-click — it is a hard stuck.** The stale
"you're ready" view is rendered without the client ever having sent
`ready(true)` for that gate. The player believes they have readied, so they
never click; the server sits at one ready flag; both players see "1 of 2 ready"
indefinitely and the game cannot advance.

Workaround for players already stuck: click "not yet", then the ready button
again — the first click only re-syncs local state, the second is the one the
server registers.

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

**See item 6** — the reason "static text" is the right description is that the
debrief conversation was never built. Moving parents into the debrief early only
pays off if there's something there to do; otherwise it relocates the wait.

**Open question to resolve before implementing:** the psychologist document
streams to clients via `DOC_CHUNK` during `processing`. If any downstream screen
or the report card assumes the document has fully landed by the time `debrief`
is entered, decoupling needs a guard. `ProcessingScreen` and the `DOC_DONE`
handling at `handlers.ts:420` are the places to check.

**Note:** the `ProcessingScreen` fragment lines are good writing and shouldn't be
thrown away with the wait — worth considering whether they move into the debrief
beat rather than disappearing.

### 4. Previous scene's conversation persists under the new scene

> "When we go to the next scene, the previous conversation is shown even though
> the scene is different at the top."

Confirmed against a screenshot: header reads `— age 3 — · 2 of 10` with the
fingernail-clipping scene description, while the messages below it are the
*shoes* conversation from scene 1.

**Cause — the transcript is never filtered by event.** `MultiplayerGame.tsx:360`
passes `state.messages` straight through to `Chat` → `MessageList`, which just
does `messages.map(...)` (`MessageList.tsx:43`). Nothing in the render chain
filters. `SoloGame.tsx:288` has the same shape.

Every message already carries the field needed to fix it — `Message.eventNumber`,
"which game event this message belongs to (set at creation time)"
(`server/src/types.ts:26`, mirrored at `client/src/hooks/useMultiplayer.ts:67`).
The admin view already groups on it (`components/admin/GameDetail.tsx:39-41`);
the play screen just never learned to.

Per-scene is clearly the intent elsewhere in the state machine too —
`END_DEBRIEF` resets `parentMessageCount` to 0 (`state-machine.ts:275`), so the
message cap is per-scene while the visible transcript is cumulative.

**Suggested direction:** filter to
`state.messages.filter(m => m.eventNumber === state.currentEventNumber)` at the
two call sites. Worth a moment's thought on whether the debrief/sidebar screens
want the same treatment, and whether the full history should stay reachable
somewhere (the scrapbook / album already covers retrospective reading).

### 5. No indication when the co-parent is typing

> "I think we should be able to tell when the other partner starts to talk or
> like starts typing."

**Not built — there is no typing/presence signal in the protocol at all.** The
event table (`client/src/hooks/useMultiplayer.ts:5-34`, mirrored in
`server/src/socket/protocol.ts`) has no `TYPING` event; grepping `typing` across
client and server turns up only two unrelated code comments. `ChildPresence.tsx`
is a portrait renderer, not presence in the multiplayer sense — the only
co-parent signals today are `PublicPlayer.connected` and `PublicPlayer.ready`
in the lobby payload.

This is additive rather than a fix: a `TYPING` event emitted on input focus /
keystroke (debounced, with a timeout so it self-clears) and broadcast to the
room, surfaced near `MessageInput`. Worth noting it compounds with #1 and #2 —
this is a two-player game where the current co-presence cues are the ready
counter and nothing else, which is likely part of why the ready gates feel load-
bearing. A live typing signal may reduce the *felt* need for some of them.

### 6. The debrief has no chat

> "ok there's no chat"

Screenshot: `later that night / the kids are asleep. it's just you two.` →
`next chapter` → `1 of 2 ready`. The screen sets up a private conversation
between the two parents and then offers no way to have it.

**The schema anticipated this conversation; it was never implemented.**
`ChatType` is `"shared" | "private" | "debrief"` (`server/src/types.ts:16`), but
**nothing anywhere ever creates a message with `chatType: "debrief"`**.
`PARENT_MESSAGE` sets `"private"` in `sidebar` and `"shared"` otherwise
(`state-machine.ts:192-194`). The single reference to the value in the whole
codebase is a defensive exclusion in the per-scene message counter
(`server/src/db/repository.ts:171`). It's vestigial.

And the phase guard makes it impossible today regardless of UI: `PARENT_MESSAGE`
is gated to `state.phase === "family_chat"`
(`state-machine.ts:111-113`), so a debrief message would throw
`Invalid transition`. Both `MultiplayerGame.tsx:503` and the solo
`Debrief.tsx` render a text block plus one button — there is no `MessageInput`
on either path.

**Suggested direction:** allow `PARENT_MESSAGE` in `debrief`, stamp it
`chatType: "debrief"`, and render `MessageInput` on the debrief screen. Two
design questions worth settling before building:

- Is the kid present? Almost certainly not — the whole framing is "the kids are
  asleep." That means no `KID_MESSAGE`, no LLM turn: it's the one screen in the
  game where two humans talk to each other with nothing generating between them.
  Cheap to build, and it's the emotional payload of the co-parenting premise.
- Does the debrief conversation feed the evaluator? It is the most honest signal
  in the game about what the parents actually think — worth deciding explicitly
  whether it enters `buildWorldManagerContext` / the identity document, or stays
  deliberately unobserved. (`visibleTo` on `Message` already supports excluding
  the kid; `repository.ts:171` already excludes debrief from the scene message
  cap, so a debrief conversation wouldn't eat the parents' scene turns.)

This is the highest-value item in this list. #1–#5 are friction; this one is a
missing room in the house.

### 7. Previous scene's setup is shown while "building the next scene…"

> "See the previous scene set up while it says building the next scene."

Screenshot: the `event_intro` screen (`— age 3 —` + the fingernail-clipping
description, `MultiplayerGame.tsx:302-304`) with `building the next scene…`
below it.

**That combination cannot be produced by one clean cycle — the `generating`
flag is stale.** Two facts, both verified:

1. The *only* `generating: true` emit in the entire server is
   `handlers.ts:376`, inside the branch guarded on
   `state.phase === "event_intro" && state.currentEvent === null`. If that
   branch is running, `currentEvent` is null, and the screen renders
   "the story continues…" (`MultiplayerGame.tsx:305`) — not a scene
   description. So a *fresh* `generating` flag and a rendered scene
   description are mutually exclusive.
2. `generating` is **client-local state that is never re-synced**. It lives in
   `useMultiplayer.ts:130` and is written by exactly one thing — the
   `E.GENERATING` listener at line 181. It is not a field on `ViewerState`
   (`handlers.ts:76-95`), so `setState(s)` on every STATE broadcast never
   corrects it. And the reconnect and join paths (`handlers.ts:312`, `:334`)
   emit `E.STATE` but **never re-emit `E.GENERATING`**.

So any client that misses the `generating: false` emit — reconnect, a dropped
frame, a tab that was backgrounded across the `finally` at `handlers.ts:387` —
is stuck displaying "building the next scene…" indefinitely, over whatever
scene the (correct) STATE broadcast last gave it. `currentEvent` is right;
the progress message is a ghost.

**Suggested direction:** make `generating` a field on `ViewerState` derived from
server state rather than a fire-and-forget event. Then every STATE broadcast
self-corrects it, reconnect included. If it stays an event, it must at minimum
be re-emitted on reconnect/join alongside STATE — but that only narrows the
window, it doesn't close it.

**Secondary point worth fixing regardless:** even with a correct flag, the
`event_intro` screen composes the *previous* scene's description with a
progress message whenever `currentEvent` is non-null, because the description
block and the ready/generating block are independent ternaries
(`MultiplayerGame.tsx:301-322`). The screen should render from one source of
truth — if we're generating, we shouldn't be showing a scene at all.

This shares a root cause with #2: both are client-local React state duplicating
something the server already owns, drifting when the server changes it out from
under them. `gateReady`, `ladderReady`, and `generating` are all the same bug
class. Worth fixing as one pass rather than three patches.

### 8. Advancing drops players back into the same conversation

> "it dropped us back into the same conversation."

Reported immediately after using the item-2 workaround to break the ready
deadlock in game `8eda7ff3`.

**The recovery branch replays the scene.** `handlers.ts:389`:

```ts
} else if (state.phase === "event_intro" && state.currentEvent !== null) {
  const next = conversationEngine.beginChat(state);
```

`beginChat` reduces to `BEGIN_FAMILY_CHAT` (`conversation-engine.ts:85-87`), and
that reducer (`state-machine.ts:176-180`) does nothing but flip `phase` to
`family_chat`. It does **not** clear `messages`, does **not** reset
`parentMessageCount`, and does **not** load a new event. So every time that
branch fires, the players land back in family_chat on the same event with the
same transcript.

The branch is commented as a one-off recovery for games stranded by the older
two-round ready gate, but it is plainly reachable in normal play. Note 7's
screenshot is corroborating evidence: `event_intro` rendering a live scene
description means `currentEvent` really is non-null at `event_intro` in the wild.

**Open question handed to implementation:** how does a game *reach*
`event_intro` with a non-null `currentEvent`? In the in-memory `games` map the
happy path goes straight from `event_intro`/null to `family_chat`/scene inside
one lock and never rests in between. Leading hypothesis is **rehydration**:
`repo.saveEvent(...)` is awaited *before* `repo.saveGame(next)`
(`handlers.ts:380-383`), leaving a window where the events table has the new
event but the games row still reads `event_intro`. If the loader reconstructs
`currentEvent` from the events table on JOIN/reconnect or after a restart, a
rehydrated game lands in exactly this state. That would explain both this item
and note 7.

Fixing the branch alone is not enough — if it is genuinely dead it should go,
and if it is still needed it must start a fresh scene rather than silently
replaying the old one. The save ordering wants to be crash-safe either way.
