# Wait-time questions, the child's memory, repair, and a practice follow-up

Status: draft for review. Items marked **[Liz]** were decided by Liz in conversation. Items marked **[my call]** are the author's defaults and are open to change.

## Intent

Raising Intelligences makes players wait: after the guardian quiz while the child's seed and first scene are built, after every scene while the psychologist and memory keeper run, and while the next scene is built. Those waits are currently passive (a scroll of small remembered moments).

Liz wants to use that time to ask players questions, in the voice of the world, so that:

1. We learn what the parent is actually dealing with, and the game can respond to it (scene choice, the child, the grandmother problem). **[Liz]**
2. We can check the child's generated personality against the parent's answers (more OCEAN-style questions). **[Liz]**
3. We can see whether players **improve across practice**, and follow up with them later like a researcher would. **[Liz]**
4. Players are shown **what the child kept** from a scene and get a **repair step**. **[Liz]**
5. The game says plainly that it is a place to practice. **[Liz]**

Why: in a month of play (Sep 25 to Oct 21, 222 conversations, 30 children) half the children never got past age three, only four reached eight or older, and we have no way to tell whether anyone learned anything or came back changed. Traces show what parents typed; they cannot show change in a person. The strongest parenting moments we have seen are parents saying something true about themselves and children keeping one line for years. We want the game to create more of those and to be able to see them.

## Goals

- Questions appear during existing waits, in the world's voice, and never delay or block the story.
- Answers are stored linked to the game and scene they came from, so intent (what the parent hoped) can be compared with outcome (what the memory keeper recorded).
- Early answers can change the first seed and scene 1; later answers feed scene generation.
- After each scene the player can see what the child kept (the memory keeper's first-person summary), and can choose to repair the moment.
- Players can opt in to email follow-ups, written and analyzed by AI, with plain-language consent.
- A defensible way to say "players who came back reported X" and no stronger.

## Non-goals

- Not a diagnostic or therapeutic tool. No claims of healing.
- Not a gate: no question, email or consent is required to play.
- Not a redesign of the quiz, the scene format or the epilogue.
- Not a causal study. No control group is promised.

## Anti-goals (failure even if it works technically)

- A parent's disclosure about their own family or health used for anything but their own game and the stated research.
- Questions that feel like a survey interrupting a story.
- Distress signals used to upsell or retarget.
- Sensitive answers readable by anyone holding a game id.
- Claiming the game improves parenting or heals, when we measured self-report from people who chose to return.

## What exists today (from code reading; not run)

Repo: `games/raising-intelligences` (symlink to this repo). Line numbers may drift.

- **Waits.** Guardian quiz posts OCEAN scores and short confessionals; one `personality_seed` call builds the child. Solo scene 1 is then built by the world manager. Post-scene: `/end-chat` runs psychologist, memory keeper and scene classifier in parallel, about 60 seconds, shown by `ProcessingScreen.tsx` (portrait, name, one fragment every 10 seconds from `FRAGMENTS_BY_AGE`, up to 8). Next-scene wait uses a `loadingEvent` spinner in `SoloGame.tsx`. Epilogue about 53 seconds, streamed.
- **Seed** (`personalitySeed`) is written once and regenerated wholesale only if a parent's personality is edited. It is not given to the psychologist or epilogue. **Identity document** (psychologist, hidden from players on purpose) and **memory summary** (memory keeper, first person, under 300 words) are rewritten after each scene. `memorySummary` already reaches the client in `/state` but nothing renders it.
- **Debrief** (`Debrief.tsx`) shows no psychologist or memory output; it offers "next event" and "end childhood".
- **Next scene** context: `buildWorldManagerContext` takes seed, previous events, family structure, the identity document, and optional `pendingGuidance` (a diegetic instruction injected into the next scene). Memory summary is not passed. The next scene is prefetched at end of chat from pre-scene state.
- **Possible existing bug:** in solo, scene 1 appears to be prefetched at game creation with an empty seed and no parent personalities; multiplayer builds it after the seed. Unconfirmed by running.
- **Data and contact.** Play is anonymous: no accounts, no email field, no consent text, no privacy policy, no age gate, no deletion path. Optional unverified Matrix id. `GET /game/:id/state` was flagged in the 2026-08-02 compliance review as exposing `parentPersonalities` to anyone with a game id (status not rechecked). The game does not tell players the child is an AI. Umami is keyed to its own session, not the game id. Migrations are numbered SQL files; nothing exists for survey answers.

## Design

Four parts, built in this order **[my call]**. Each part is independently shippable.

### A. Foundations (before collecting anything sensitive)

- Close the `/state` exposure of parent personalities and any new sensitive fields; sensitive reads require the player's token, not just the game id.
- Say on first screen that the child is an AI, and that this is a place to practice, not therapy. Crisis resources reachable from the same place.
- **Birth year, asked at the start [Liz]**, as part of the existing intake steps (`GuardianScreen.tsx` `STEPS`), before the quiz and before the first wait. Year only, never a full date. It is self-declared and we accept that. Players who are 18 or older have the year stored with the game (useful as a covariate). Players under 18 can play but are never shown research questions, the email step or scales, and for them only an under-18 flag is stored, not the year or any answers. Because the gate comes first, the first-wait "about you" questions are covered by it.
- A privacy page and a deletion path covering the new tables.
- Treat the above as the minimum; counsel reviews the consent basis and age handling before the first email is collected **[my call]**.

### B. Questions in the waits

Surface: a small card under the existing fragment on `ProcessingScreen`, the guardian-quiz waiting step, and the next-scene spinner. One card at a time, answered by a tap or a short line of text, skippable, never blocks. When the scene is ready, the card fades; unanswered questions wait for the next wait. Voice: the same gentle second-person voice as the fragments **[Liz]**. A card that is a plain survey item is not acceptable; a fixed scale item is rendered as a world-voiced prompt with fixed answer options.

Three kinds of question **[my call]**:

1. **About you** (first wait, before the seed call where possible): the climate you grew up in, who has opinions about how you parent (partner, in-law, teacher), what you worry about for this child, how much this child is like you. These feed the seed prompt and scene 1 context so the right pressure is chosen instead of defaulting to the critical grandmother.
2. **About the moment** (post-scene waits): what you hoped the child would take from that, how you felt in it. Stored with the scene so it can be compared against the memory keeper's summary.
3. **Fixed-scale items** (start and end of a child's arc, a few at a time, spread across waits): used for the follow-up study. Keep wording identical across players and sessions. Exact scales are chosen under Part D.

Storage: a new table keyed by game id, scene index, question id and wording version, with the answer, time shown, time answered, and whether skipped. Skips are data. Question bank is versioned in the repo. Per-player cap per wait: about as many cards as fit the wait; the post-scene wait is about 60 seconds, so a small number.

Data use: answers of kind 1 may be added to the seed prompt and to the world manager's context (through the existing `pendingGuidance` mechanism or an explicit field), and to the psychologist so the seed is no longer invisible downstream **[my call]**.

### C. What the child kept, and repair

- After each scene, the debrief shows the memory keeper's first-person summary. The psychologist's identity document stays hidden **[my call]**.
- Below it, an optional invitation to go back to that moment (repair). If taken, the player gets a short exchange (or a single message) before the next scene, and the world manager is told through `pendingGuidance` that a repair was attempted and what the player said. The prefetched next scene must be discarded and rebuilt when repair is taken **[my call]**.
- Log whether the player repaired, what the rupture was, and whether subsequent scenes show the child keeping the repair. This is the main behavior signal for "did the player practice something".
- The player's "what I hoped" answer from Part B can be shown beside the child's summary: "what you meant" next to "what stayed". Whether to show it or only log it is left to the builder with a lean toward showing it.

### D. Follow-up study

- At the end of an arc (and at any point from a menu), offer: "Would you like us to check in with you later?" with a separate email field, and a separate consent for AI-written and AI-analyzed follow-up questions. Email is stored apart from answers, joined by a pseudonymous id.
- Fixed scales are few (about 10 to 20 items in total across start and end), reused word for word. Candidates: ERQ (emotion regulation, 10 items), PRFQ (parental reflective functioning, 18 items), a short self-efficacy set; PSOC was considered but a 2025 paper questions its use for repeated measures. **Licensing for all of these is unconfirmed; the authors must be asked before use.** For players without children, wording is adapted and labeled exploratory, never presented as the validated instrument.
- AI-written follow-ups are kept separate from the fixed scales; open answers are analyzed by AI; no distress language is analyzed as data: it triggers a resources message instead. Adversarial testing of this path is required.
- Log dose (scenes and arcs played) with each response. Compare responders and non-responders at baseline. Randomize who is shown the first prompt where cheap. Claims limited to "players who returned reported higher/lower X"; no claim of improving parenting or healing.
- If publication is intended, independent ethics review before the first email. Mandatory-reporting policy for disclosures of child abuse decided with counsel.

## Constraints

- No time estimates in any plan derived from this document.
- Play stays possible without answering, without email, and without accounts.
- Questions never lengthen a wait; if the scene is ready the card goes.
- The kid-model rotation and Langfuse logging keep working; new LLM calls (follow-up writer, analyzer) must be traced and use the same model-config roles.
- No secrets in client code; follow existing observability and admin patterns.

## Decided by Liz

Questions in the waits during scene generation; world-voiced; liked the repair step and showing what the child kept; wants improvement across practice with email follow-up like a scientist, and a consent step at the end for AI-written, AI-analyzed follow-ups; wants the "place to practice" message; thinks low retention is mostly players bouncing.

## My calls (please check)

Order A, B, C, D; 18+ gate and counsel review before email; question kinds and which wait gets which; feeding answers into the seed, the world manager and the psychologist; showing the memory keeper summary but not the identity document; repair offered optionally right after the summary, with the prefetched next scene kept running and discarded only if the player takes the repair; fixed scales separate from AI-written follow-ups; no research data about under-18s; ethics review if publishing.

## Resolved after builder review

Answered by the code: the solo scene-1 bug is real. `POST /game` (`server/src/routes/game.ts:116`) prefetches scene 1 from the empty initial state, `/next-event` consumes it (`game.ts:207-212`), and the `/personality` handler (`game.ts:755`) never discards it. Fixing it is therefore a **prerequisite of Part B**, not a side issue: scene 1 must be built after the seed, as multiplayer already does.

Also answered by the code: the `/state` exposure of `parentPersonalities` flagged in the August compliance review is already fixed (`server/src/routes/game.ts:118-155`, #139), so Part A needs only a regression test for it. The plan covers the solo path only; multiplayer has no birth-year step, so multiplayer games get no research features and per-parent attribution is deferred.

My calls, to be checked:

- **Scope.** Full plan for A, B and C. D is planned up to a hand-off point and gated on counsel review, scale licensing and ethics review.
- **Seed timing.** The seed call is never delayed. Answers given during the seed wait cannot reach that call. They feed scene 1 (built after the seed) and are added to the context the child is given as what the parent said about themselves. Only questions answered before the quiz ends can shape the seed itself.
- **Post-scene answers.** "About the moment" answers go to the memory comparison and to the next scene only if they arrive before it is built; the prefetch is not delayed for them.
- **Repair cost.** The prefetch keeps running during the offer. If the player takes the repair, it is discarded and the next scene is rebuilt after the repair, which lengthens that wait. Log the repair rate; revisit if it is high.
- **Classifying rupture and repair.** A new small, traced LLM role compares the player's "what I hoped" answer, the repair message and the memory keeper summary, and labels them. Its prompt and an eval set are part of the work. Labels are stored, not shown to players.
- **Sensitive-read access.** A per-game secret is issued at creation and kept client-side; reads of sensitive fields require it. Games created before this change keep working but cannot read sensitive fields by game id alone. Multiplayer attributes each answer to the parent who gave it.
- **Deletion key.** Game id plus the per-game secret; for follow-up participants, the email as well.
- **Production persistence.** Unknown from the repo (only the Langfuse compose file mentions `DATABASE_URL`). The plan's first step is to confirm production uses Postgres. If it does not, persistence is a prerequisite of everything here.
- **Copy.** The question bank may ship with placeholder copy; Liz reviews the wording before it goes live.

## Left to the builder

Card layout, animation and copy for each question; the question bank wording (in the world's voice, reviewed by Liz); schema details; whether repair is one message or a short exchange; whether "what you meant" appears beside "what stayed"; how to detect and handle distress language; the exact scale items once licensing is settled; whether to fix the solo scene-1 prefetch bug as part of Part A or separately.

## Open items needing outside input

- Production persistence: confirmed Postgres (`DATABASE_URL` is set in the running `raising-intelligences` container; presence test only, value not read).

- Licensing of the chosen scales.
- Counsel review of consent basis, retention, third-party model processing, COPPA/GDPR treatment, mandatory reporting.
- Whether production uses Postgres or in-memory state (the compliance review lists this as open).
