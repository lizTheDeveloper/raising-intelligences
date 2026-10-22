# Wait-Time Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask solo players world-voiced questions during the game's existing waits, show them what the child kept from each scene with an optional repair, and lay the consent-gated groundwork for an opt-in follow-up study.

**Architecture:** A server-side question bank and an answers table, served through new secret-protected routes. A client `WaitQuestionCard` renders one skippable card under the existing wait screens. Answers flow back into scene generation through an in-memory `GameState.parentContext`, rehydrated from the answers table. Birth year (asked on the name screen) and a per-game secret gate every research read and write on the server, not in the client.

**Tech Stack:** TypeScript, Express, vitest (server tests, `buildServer` + `MockLLMClient` + `InMemoryGameRepository`), Postgres via numbered SQL migrations, React/Vite client (no client test runner; client work is verified by type-check, build and a Playwright smoke).

**Spec:** `docs/superpowers/specs/2026-10-21-wait-time-questions-design.md`

## Scope decisions made while planning (check these)

- **Solo path only.** Multiplayer has no birth-year step and the spec's per-parent attribution is deferred: multiplayer games record `is_adult = NULL` and never see research cards, repair or the follow-up. The spec said multiplayer answers would be attributed per parent; that is not in this plan.
- **Part A's `/state` leak is already fixed** (`server/src/routes/game.ts:118-155`, issue #139). Part A therefore adds a regression test, not new code, for that item.
- **Part D stops at the mechanism**: follow-up consent and email capture, and the scale-item licensing guard. The AI-written follow-up writer, the AI analyzer, distress handling and real scale items are not planned here; they wait on counsel review, scale licensing and ethics review.
- **Adult rule is conservative.** Year-only birth data cannot tell who has turned 18, so `is_adult` is true only when `currentYear - birthYear >= 19`.

## Global Constraints

- No time estimates anywhere in code comments, docs or commit messages.
- Play never requires an answer, an email, a consent or an account. Every card is skippable and never blocks or delays a wait.
- Research data is collected only when `RI_RESEARCH_ENABLED === "true"` AND the game's `is_adult === true`. Both checks are enforced on the server.
- Under-18 players: store only `is_adult = false`. Never store their birth year, answers, repair text, labels or contact details.
- Birth year is a year only (integer), never a full date.
- Question wording is world-voiced (gentle second person, same voice as the fragments in `ProcessingScreen.tsx`). Copy shipped here is placeholder; Liz reviews it before `RI_RESEARCH_ENABLED` is turned on in production.
- Fixed-scale items are word-for-word identical across players and never mixed with AI-written text. A scale item with `licenseCleared !== true` is never served.
- Email is stored apart from answers, joined only by a pseudonymous id.
- New LLM calls go through the existing traced client with a role in `server/src/llm/model-config.ts`.
- Sensitive reads/writes require the per-game secret in header `x-game-secret`; the secret is stored only as a SHA-256 hash.
- Every PR bumps the version (`package.json` and `package-lock.json`).
- Never print env files or container environment.

## Review Focus

1. A forged request from an under-18 or legacy game (no `is_adult`, no secret) to the questions, answers, repair-storage, follow-up or labels paths must fail on the server, not just be hidden in the UI.
2. A card answered after the next scene has started must be stored against the scene it was shown in, not the current one.
3. Free-text answers containing instructions to the model, control characters, or enormous length must not reach a prompt unsanitized or uncapped.
4. A game resumed on another device (secret lost) or created before this change (no secret hash) must stay fully playable, with research features simply absent and no crash.
5. Double-submitting the same question, answering and skipping the same question, and the scene becoming ready while a card is open must not create duplicate rows or block the story.

---

## File Structure

New server files: `server/src/research/{config,age,questions,parent-context,moment-label}.ts`, `server/src/security/game-secret.ts`, `server/src/routes/research.ts`, migrations `021`–`024`.
Modified server files: `server/src/routes/game.ts`, `server/src/db/repository.ts`, `server/src/game/{context-assembler,conversation-engine,state-machine}.ts`, `server/src/types.ts`, `server/src/llm/model-config.ts`, `server/src/app.ts`.
New client files: `client/src/hooks/{gameSecret,useWaitQuestions}.ts`, `client/src/components/WaitQuestionCard.tsx`, `client/src/components/FollowupOffer.tsx`, `client/public/privacy.html`.
Modified client files: `client/src/hooks/useGame.ts`, `client/src/components/{SoloGame,GuardianScreen,ProcessingScreen,Debrief,Endgame}.tsx`, `client/src/global.css`.
Tests: `server/tests/research-*.test.ts` (one file per task area below).

---

### Task 1: Confirm production persistence (no code)

**Files:** none changed. Record the result in a one-line note at the top of the spec's "Open items" section.

- [ ] **Step 1: Find the deploy target.** Read `deploy/` and `README.md` for where RI runs and how it is configured.
- [ ] **Step 2: Check whether `DATABASE_URL` is set in the running server without printing it.** Use a presence test only, e.g. `docker exec <container> sh -c '[ -n "$DATABASE_URL" ] && echo set || echo unset'`. Never print the value or the environment.
- [ ] **Step 3: Record the answer.** If `unset`, stop and report to Liz: persistence is a prerequisite of every later task. If `set`, continue.
- [ ] **Step 4: Commit** the spec note.

---

### Task 2: Build scene 1 after the seed (solo prefetch bug)

**Files:**
- Modify: `server/src/routes/game.ts:116` and the `/personality` handler at `:755`
- Test: `server/tests/research-opening-seed.test.ts`

**Interfaces:**
- Consumes: `engine.prefetchNextEvent(state)`, `engine.startEvent(state)`, `prefetchedEvents` map in `game.ts`.
- Produces: guarantee that the first scene's world-manager call sees a non-empty `personalitySeed`. Later tasks rely on this to make early answers affect scene 1.

- [ ] **Step 1: Write the failing test** `scene 1 world-manager context contains the personality seed`: build a server with a recording `MockLLMClient`, `POST /api/game`, `POST /api/game/:id/personality` with valid OCEAN `[3,3,3,3,3]` and `confessional1: "x"`, then `POST /api/game/:id/next-event`. Assert the system prompt passed for the `world_manager` role contains the seed text the mock returned for `personality_seed`, and that the world-manager call count is 1 (no wasted pre-seed prefetch).
- [ ] **Step 2: Run it** `npm test -w server -- research-opening-seed` and confirm it fails (prefetch built from empty state).
- [ ] **Step 3: Remove the creation-time prefetch** at `game.ts:116` and its comment; keep `/next-event` falling back to `engine.startEvent(state)` when no prefetch exists. Do not touch the post-scene prefetch at `game.ts:438`.
- [ ] **Step 4: Run** the new test and `npm test -w server -- opening` and confirm PASS.
- [ ] **Step 5: Commit** `fix(solo): build scene 1 after the personality seed`.

---

### Task 3: Birth year, adult flag, research switch

**Files:**
- Create: `server/src/research/config.ts`, `server/src/research/age.ts`, `server/src/db/migrations/021-age-and-secret.sql`
- Modify: `server/src/db/repository.ts` (interface + Pg + InMemory), `server/src/routes/game.ts` (`POST /game`)
- Test: `server/tests/research-age.test.ts`

**Interfaces:**
- Produces:
  - `isResearchEnabled(): boolean` (`config.ts`) — true only if `process.env.RI_RESEARCH_ENABLED === "true"`.
  - `classifyBirthYear(input: unknown, now?: Date): { ok: true; birthYear: number; isAdult: boolean } | { ok: false; error: string }` (`age.ts`) — requires an integer, `1900 <= year <= now.getFullYear()`, `isAdult = now.getFullYear() - year >= 19`.
  - Repository: `recordAge(gameId: string, age: { birthYear: number | null; isAdult: boolean }): Promise<void>`; `getIsAdult(gameId: string): Promise<boolean | null>` (null for games with no record).
  - `POST /api/game` accepts optional `birthYear`. Missing → no record (`getIsAdult` null). Invalid → 400. Adult → stores year and `isAdult: true`. Under 18 → stores `{ birthYear: null, isAdult: false }`.
- Migration `021`: `ALTER TABLE games ADD COLUMN IF NOT EXISTS birth_year INT, ADD COLUMN IF NOT EXISTS is_adult BOOLEAN, ADD COLUMN IF NOT EXISTS access_secret_hash TEXT;` (secret column used by Task 4), nullable, no defaults, with a comment explaining null means "unknown".

- [ ] **Step 1: Write failing tests** for `classifyBirthYear` (table: 2000→adult, 2007 in 2026→not adult, 2008→not adult, 2026→not adult, 1899/"abc"/1.5/null/undefined/future year→error) and for the route (under-18 body stores no year, adult stores year, missing year stores nothing, `"2000"` string is rejected).
- [ ] **Step 2: Run** `npm test -w server -- research-age`, confirm FAIL.
- [ ] **Step 3: Implement** the modules, migration and repository methods in both repository classes, and wire `POST /game`.
- [ ] **Step 4: Run** the tests plus `npm test -w server -- game` and confirm PASS.
- [ ] **Step 5: Commit** `feat(research): birth year, adult flag and research switch`.

---

### Task 4: Per-game secret

**Files:**
- Create: `server/src/security/game-secret.ts`
- Modify: `server/src/db/repository.ts`, `server/src/routes/game.ts` (`POST /game` response), `server/src/app.ts` (CORS allowed header `x-game-secret` if headers are allow-listed)
- Test: `server/tests/research-secret.test.ts`

**Interfaces:**
- Produces:
  - `newGameSecret(): { secret: string; hash: string }` — 32 random bytes hex; `hash` is SHA-256 hex.
  - `verifyGameSecret(secret: string | undefined, hash: string | null): boolean` — timing-safe; false for undefined, empty, or null hash.
  - `requireGameSecret(repo: GameRepository): RequestHandler` — reads `x-game-secret`, loads hash via `repo.getAccessSecretHash(req.params.id)`, responds 403 `{ error: "Forbidden" }` on failure.
  - Repository: `recordAccessSecretHash(gameId: string, hash: string): Promise<void>`; `getAccessSecretHash(gameId: string): Promise<string | null>`.
  - `POST /api/game` response becomes `{ gameId, secret }`.

- [ ] **Step 1: Write failing tests**: secret verifies; wrong secret, empty secret, undefined and null-hash all fail; `POST /api/game` returns a `secret`; the stored hash never equals the secret; the middleware returns 403 for a legacy game with no hash even when a header is sent.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement** with Node `crypto` (`randomBytes`, `createHash`, `timingSafeEqual`).
- [ ] **Step 4: Run** the tests plus the existing game route tests and confirm PASS.
- [ ] **Step 5: Commit** `feat(security): per-game secret for sensitive routes`.

---

### Task 5: Regression test for `/state` and deletion

**Files:**
- Modify: `server/src/db/repository.ts` (add `deleteGameData`), `server/src/routes/game.ts` (add `DELETE /game/:id`)
- Test: `server/tests/research-privacy.test.ts`

**Interfaces:**
- Consumes: `requireGameSecret` (Task 4).
- Produces: `repo.deleteGameData(gameId: string): Promise<void>` — removes the game row and every row in every table keyed by `game_id`, including tables added by Tasks 7, 14 and 17; `DELETE /api/game/:id` (secret required) → 204, also evicts the game from the in-memory `games` map and `prefetchedEvents`.

- [ ] **Step 1: Write failing tests**: (a) `GET /api/game/:id/state` never contains `parentPersonalities`, `identityDocument` or any answer text (regression for #139); (b) `DELETE` without or with a wrong secret → 403 and data intact; (c) with the right secret → 204, subsequent `GET /state` → 404; (d) a Pg-only test (skipped without `DATABASE_URL`) that queries `information_schema.columns` for every table with a `game_id` column and asserts each is empty for the deleted game, so a table added later without deletion coverage fails.
- [ ] **Step 2: Run** and confirm (b)–(d) FAIL.
- [ ] **Step 3: Implement** `deleteGameData` for both repository classes (use `ON DELETE CASCADE` where foreign keys already exist; otherwise explicit deletes inside one transaction in Pg).
- [ ] **Step 4: Run** and confirm PASS.
- [ ] **Step 5: Commit** `feat(privacy): delete a game and everything keyed to it`.

---

### Task 6: Disclosure, practice framing, birth-year field, privacy page (client)

**Files:**
- Create: `client/src/hooks/gameSecret.ts`, `client/public/privacy.html`
- Modify: `client/src/hooks/useGame.ts` (`createGame`), `client/src/components/SoloGame.tsx` (name screen near line 300–330), `client/src/components/Credits.tsx`, `client/src/global.css`

**Interfaces:**
- Produces:
  - `saveGameSecret(gameId: string, secret: string): void` and `getGameSecret(gameId: string): string | null` in `gameSecret.ts` — `localStorage` key `ri_game_secret:<gameId>`, every access in try/catch, never throws.
  - `createGame(name: string, relationshipType?: string, birthYear?: number): Promise<string | null>` — sends `birthYear`, stores the returned `secret`.
  - A numeric birth-year input on the "name your child" screen (label: "the year you were born"), required before start; non-numeric or out-of-range input disables the start button.
  - One visible line on that screen: the child is an AI; this is a place to practice, not therapy; a link to `/privacy.html`; a crisis-line line ("If you're in crisis, call or text 988 in the US, or find a local line at findahelpline.com"). Placeholder wording, marked `// COPY: pending Liz review`.
  - `privacy.html`: what is stored, that research questions are optional and only for adults, how to delete (links the deletion endpoint's UI is out of scope; state the contact route), marked `DRAFT — pending counsel review` visibly in the page.

- [ ] **Step 1: Implement** the above.
- [ ] **Step 2: Verify** `npm run build -w client` and `npx tsc -p client --noEmit` pass.
- [ ] **Step 3: Playwright smoke** (follow the `game-playtesting` skill): load the app locally, confirm the start button is disabled with no year, enabled with `1990`, and that a created game stores a secret in localStorage.
- [ ] **Step 4: Commit** `feat(client): birth year, AI disclosure and privacy page`.

---

### Task 7: Question bank, answers table, research routes

**Files:**
- Create: `server/src/research/questions.ts`, `server/src/routes/research.ts`, `server/src/db/migrations/022-question-answers.sql`
- Modify: `server/src/db/repository.ts`, `server/src/app.ts` (mount `createResearchRoutes`), `server/src/types.ts` (add `parentContext?: string` and `repairNote?: string | null` to `GameState`, both in-memory only)
- Test: `server/tests/research-questions.test.ts`

**Interfaces:**
- Produces:
  - Types in `questions.ts`: `WaitKind = "first" | "post_scene" | "next_scene"`; `QuestionKind = "about_you" | "about_moment" | "scale"`; `Question = { id: string; version: number; kind: QuestionKind; prompt: string; waits: WaitKind[]; answer: { type: "tap"; options: { value: string; label: string }[] } | { type: "text"; maxLength: number }; licenseCleared?: boolean }`.
  - `QUESTION_BANK: Question[]` — placeholder world-voiced copy covering: growing-up climate (tap), who has opinions on how you parent (tap), what worries you for this child (text, 300), how like you is this child (tap), "what did you hope they'd take from that?" (text, 300, `about_moment`, `post_scene`). No `scale` items yet.
  - `selectQuestions(args: { wait: WaitKind; answeredIds: ReadonlySet<string>; limit: number }): Question[]` — in bank order, kind `scale` only when `licenseCleared === true`.
  - `StoredAnswer = { gameId: string; sceneIndex: number; questionId: string; questionVersion: number; kind: QuestionKind | "repair"; answer: unknown; skipped: boolean; shownAt: number; answeredAt: number }`.
  - Repository: `saveAnswer(a: StoredAnswer): Promise<void>` (upsert on `(game_id, scene_index, question_id)`); `listAnswers(gameId: string): Promise<StoredAnswer[]>`.
  - `GET /api/game/:id/questions?wait=<WaitKind>` → `{ questions: Question[] }` (max 2; `[]` when research disabled, game not adult, or nothing left). `POST /api/game/:id/answers` body `{ questionId, version, sceneIndex, answer?, skipped?, shownAt }` → 204. Both require the secret (Task 4), `isResearchEnabled()`, and `getIsAdult(id) === true`; otherwise 403 (secret) or 404 `{ error: "Not available" }`.
  - Server rules on POST: unknown `questionId`/`version` → 400; `sceneIndex` greater than the game's `currentEventNumber` → 400; text answers are trimmed and capped at the question's `maxLength`; tap answers must match an option value; a second submit for the same key overwrites (answer beats skip).
- Migration `022`: table `question_answers` with the columns above, `answer JSONB`, unique `(game_id, scene_index, question_id)`, index on `game_id`.

- [ ] **Step 1: Write failing tests**: forged requests (no secret, wrong secret, under-18 game, legacy game, research disabled) all fail; valid tap/text answers round-trip through `listAnswers`; a late answer with an older `sceneIndex` is stored against that index; oversize text is capped; double submit leaves one row; skip then answer leaves the answer; `selectQuestions` excludes answered ids and unlicensed scale items (use a test-only bank).
- [ ] **Step 2: Run** `npm test -w server -- research-questions` and confirm FAIL.
- [ ] **Step 3: Implement** modules, migration, repository methods and routes.
- [ ] **Step 4: Run** and confirm PASS.
- [ ] **Step 5: Commit** `feat(research): question bank and answers API`.

---

### Task 8: Wait cards in the client

**Files:**
- Create: `client/src/hooks/useWaitQuestions.ts`, `client/src/components/WaitQuestionCard.tsx`
- Modify: `client/src/components/ProcessingScreen.tsx`, `client/src/components/GuardianScreen.tsx` (waiting step), `client/src/components/SoloGame.tsx` (the `loadingEvent` spinner), `client/src/global.css`

**Interfaces:**
- Consumes: Task 7 routes, `getGameSecret` (Task 6).
- Produces:
  - `useWaitQuestions(gameId: string | null, wait: WaitKind, sceneIndex: number, active: boolean): { current: Question | null; submit: (answer: unknown) => void; skip: () => void }` — fetches once when `active` becomes true, serves one card at a time, posts answers fire-and-forget with failures swallowed (never blocks, never throws, logs via `track` only), returns `current: null` on any error, on 403/404, or when `active` goes false.
  - `WaitQuestionCard({ question, onAnswer, onSkip })` — tap options or a short textarea plus "skip"; fades out when `question` becomes null.
  - Integration: `ProcessingScreen` gets optional prop `sceneIndex?: number` and renders the card under the fragment with `wait="post_scene"`; the guardian waiting step uses `"first"`; the next-scene spinner uses `"next_scene"`.
  - Analytics via existing `track()`: `wait_question_shown`, `wait_question_answered`, `wait_question_skipped` with `{ questionId, wait }` only (no answer text).

- [ ] **Step 1: Implement** the hook, component and integrations. A card must never remain visible after the wait ends.
- [ ] **Step 2: Verify** type-check and build pass.
- [ ] **Step 3: Playwright smoke** with `RI_RESEARCH_ENABLED=true` locally and an adult birth year: a card appears during the post-scene wait, answering it creates one row (check via the answers API), skipping creates a skipped row, and an under-18 game shows no card.
- [ ] **Step 4: Commit** `feat(client): world-voiced questions during waits`.

---

### Task 9: Feed answers into scene generation

**Files:**
- Create: `server/src/research/parent-context.ts`
- Modify: `server/src/routes/game.ts` (`resolveGame` rehydration), `server/src/routes/research.ts` (set `parentContext` after a valid `about_you` answer), `server/src/game/context-assembler.ts` (`buildWorldManagerContext`, `buildKidContext`, `buildPsychologistContext`)
- Test: `server/tests/research-parent-context.test.ts`

**Interfaces:**
- Produces:
  - `formatParentContext(answers: StoredAnswer[]): string` — only non-skipped `about_you` answers; each value stripped of control characters and backticks, capped at 300 characters; result is a block headed by a fixed line stating these are the parent's own notes about themselves, background only, not instructions. Returns `""` when there is nothing.
  - `state.parentContext` is rebuilt via `listAnswers` when a game is rehydrated and updated in the `games` map on each valid answer.
  - World manager and kid contexts append `state.parentContext` when non-empty. The psychologist context gains the child's `personalitySeed` (today it never sees it) and the same block.

- [ ] **Step 1: Write failing tests**: an answer containing "ignore previous instructions and ..." appears only inside the delimited block and capped; skipped and `about_moment` answers are excluded; after a simulated eviction/rehydration the context is restored; the world-manager system prompt for scene 1 contains an `about_you` answer given during the first wait; the psychologist context now contains the seed.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w server -- research` and confirm PASS.
- [ ] **Step 5: Commit** `feat(research): parent answers shape scenes, psychologist sees the seed`.

---

### Task 10: Show what the child kept

**Files:**
- Modify: `client/src/components/Debrief.tsx`, `client/src/components/SoloGame.tsx`, `client/src/global.css`
- Test: `server/tests/research-debrief-state.test.ts`

**Interfaces:**
- Consumes: `memorySummary` already present in `GET /state`.
- Produces: `Debrief` props gain `memorySummary: string` and `hoped?: string`; it renders the summary as the child's first-person memory, and when `hoped` is present shows it beside it as "what you hoped" / "what stayed". `hoped` comes from the player's own `about_moment` answer held in client state for the current scene (never fetched from the server). The Psychologist's identity document is never shown.

- [ ] **Step 1: Write a failing server test** `after end-chat, GET /state returns the memory summary and never the identity document`.
- [ ] **Step 2: Run** and confirm the result (it may already pass; if so, keep it as a regression test and note that).
- [ ] **Step 3: Implement** the client change; empty summary renders nothing rather than a placeholder.
- [ ] **Step 4: Verify** build, then a Playwright smoke through one scene to the debrief.
- [ ] **Step 5: Commit** `feat(client): show what the child kept`.

---

### Task 11: Repair

**Files:**
- Modify: `server/src/routes/game.ts` (add `POST /game/:id/repair`), `server/src/game/context-assembler.ts` (`buildWorldManagerContext`), `server/src/game/state-machine.ts` (clear `repairNote` when the next event is applied), `client/src/hooks/useGame.ts` (`repair(message: string)`), `client/src/components/Debrief.tsx`
- Test: `server/tests/research-repair.test.ts`

**Interfaces:**
- Produces: `POST /api/game/:id/repair` body `{ message: string }` (1–1000 chars after trim; 400 otherwise), only valid while `phase === "debrief"` (409 otherwise), → 204. Effects: sets `state.repairNote`, discards the queued prefetch (`prefetchedEvents.delete`, with `.catch(() => {})` on the dropped promise), so `/next-event` rebuilds. `buildWorldManagerContext` appends a fixed instruction that the parent went back to the last moment and said the (sanitized, delimited) message to the child, and the next scene should open on the child's reaction without naming it as a repair. The repair works for every player. It is stored as an answer (`kind: "repair"`, `questionId: "repair"`, version 1) only when research is enabled, the secret is valid and the game is adult.
- Client: after the memory summary, an optional "go back to that moment" control with a short text box; submitting calls `repair` and then proceeds to the next scene; ignoring it changes nothing.

- [ ] **Step 1: Write failing tests**: repair outside `debrief` → 409; empty/oversize message → 400; a valid repair makes the next `/next-event` world-manager prompt contain the message and bypass the prefetch; no repair leaves the prefetch used; an under-18 game repairs successfully but nothing is stored; an adult research game stores one row.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement** server then client.
- [ ] **Step 4: Run** `npm test -w server -- research-repair` and confirm PASS; Playwright smoke through a repair.
- [ ] **Step 5: Commit** `feat: optional repair of the last moment`.

---

### Task 12: Label hope-vs-kept and repair outcomes

**Files:**
- Create: `server/src/research/moment-label.ts`, `server/src/db/migrations/023-moment-labels.sql`
- Modify: `server/src/llm/model-config.ts` (new role `moment_comparison` mapped in every tier map, cheapest narrative model per tier), `server/src/game/conversation-engine.ts` (`endFamilyChat`), `server/src/db/repository.ts`
- Test: `server/tests/research-moment-label.test.ts`

**Interfaces:**
- Produces:
  - `type MomentLabelKind = "hope_vs_kept" | "repair_kept"`; `type MomentLabel = { kind: MomentLabelKind; label: "match" | "partial" | "mismatch" | "unclear"; rationale: string }`.
  - `labelMoment(llm: LLMClient, input: { kind: MomentLabelKind; hoped: string | null; repair: string | null; memorySummary: string }): Promise<MomentLabel>` — never throws; any model failure or unparsable output returns `{ label: "unclear", rationale: "" }`.
  - Repository: `saveMomentLabel(gameId: string, sceneIndex: number, label: MomentLabel): Promise<void>`.
  - `endFamilyChat`, after the memory summary exists and only for research-eligible games (enabled, adult): label `hope_vs_kept` when the scene has an `about_moment` answer; label `repair_kept` for scene N+1 when scene N had a repair. Runs without awaiting the player's flow (fire-and-forget with logged errors), never delays `IDENTITY_UPDATED`.
- Labels are stored only, never shown to players, never fed back into prompts.

- [ ] **Step 1: Write failing tests** with `MockLLMClient`: parsing of a well-formed response, malformed/empty/throwing model → `unclear`, nothing is labeled for a non-eligible game, a labeling failure does not change the scene's phase transition, and the `moment_comparison` role is present in every tier map.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement.** Add a small fixture set of 6 hand-written (hoped, summary) pairs with expected labels as an eval file under `server/tests/fixtures/moment-labels.json`, run only when `LLM_CACHE_MODE=record`.
- [ ] **Step 4: Run** and confirm PASS.
- [ ] **Step 5: Commit** `feat(research): label whether the child kept what the parent hoped`.

---

### Task 13: Follow-up consent and contact (mechanism only)

**Files:**
- Create: `server/src/db/migrations/024-followup.sql`, `client/src/components/FollowupOffer.tsx`
- Modify: `server/src/routes/research.ts`, `server/src/db/repository.ts`, `client/src/components/Endgame.tsx`
- Test: `server/tests/research-followup.test.ts`

**Interfaces:**
- Produces:
  - Tables `followup_links(game_id, pseudonym_id)` and `followup_contacts(pseudonym_id, email, consent_followup BOOLEAN, consent_ai_analysis BOOLEAN, consented_at, withdrawn_at)`, kept separate so email is never in the same table as answers.
  - Repository: `saveFollowupContact(gameId: string, c: { email: string; consentFollowup: true; consentAiAnalysis: true }): Promise<void>`; `withdrawFollowup(gameId: string): Promise<void>`.
  - `POST /api/research/followup/:id` body `{ email, consentFollowup, consentAiAnalysis }` and `DELETE /api/research/followup/:id` — secret, research enabled, adult game required. Both consents must be exactly `true` as two separate fields; syntactically invalid email → 400. Withdrawing deletes the email and sets `withdrawn_at`. `deleteGameData` (Task 5) removes both tables' rows.
  - Client: after the epilogue/report card, `FollowupOffer` — an unchecked pair of consent boxes and an email field, plain-language text (what is collected, that an AI writes and analyzes the follow-ups, how to withdraw, not therapy, crisis line, `Skip`), placeholder copy marked pending counsel review. Hidden when the server says research is unavailable for this game.
- Not in this plan: the AI follow-up writer, the AI analyzer, distress handling, real scale items.

- [ ] **Step 1: Write failing tests**: each consent missing/false → 400; both true + valid email → stored; under-18, legacy, no-secret and research-disabled forged calls fail; withdraw clears the email; `deleteGameData` clears both tables; email never appears in `listAnswers` or any answers route response.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement** server then client.
- [ ] **Step 4: Run** `npm test -w server -- research-followup` and confirm PASS; Playwright smoke for the offer (shown for an adult research game, absent for under-18).
- [ ] **Step 5: Commit** `feat(research): opt-in follow-up consent and contact`.

---

### Task 14: Whole-branch verification and release

**Files:** `package.json`, `package-lock.json` (version bump), no feature code.

- [ ] **Step 1: Bump the version** to the next minor in `package.json` and `package-lock.json`.
- [ ] **Step 2: Run the full server suite** `npm test` and the client build `npm run build -w client`; confirm both pass with no skipped-by-accident tests.
- [ ] **Step 3: Playwright end-to-end** on a local run with `RI_RESEARCH_ENABLED=true`: adult game gets cards in all three waits, the debrief shows the child's memory, a repair changes the next scene, and an under-18 game shows no cards, no repair storage and no follow-up offer; also confirm `RI_RESEARCH_ENABLED` unset shows no research UI at all.
- [ ] **Step 4: Confirm** `GET /state` contains no answers, no contact data and no `parentPersonalities`.
- [ ] **Step 5: Commit** and open the PR. Do not enable `RI_RESEARCH_ENABLED` in production until Liz has reviewed the copy and counsel has reviewed consent and age handling.

---

## Self-review notes

- **Spec coverage:** Part A (disclosure, practice framing, birth year, secret, privacy, deletion, `/state` regression) → Tasks 3–6; Part B (cards, three kinds, storage, seed/scene-1 feeding, psychologist sees seed) → Tasks 2, 7–9; Part C (memory display, repair, labeling) → Tasks 10–12; Part D mechanism → Task 13. Not covered, by decision: multiplayer, AI follow-up writer/analyzer, real scales, ethics review.
- **Type consistency:** `WaitKind`, `Question`, `StoredAnswer` are defined once in Task 7 and consumed by Tasks 8, 9, 11, 12; `getIsAdult` and `requireGameSecret` are defined in Tasks 3–4 and used in 5, 7, 11, 13.
