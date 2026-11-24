# Observability

Two systems cover different layers: **Umami** tracks player behavior in the browser; **Langfuse** traces every LLM call on the server.

---

## Umami — player analytics

**Dashboard:** `https://analytics.multiversestudios.xyz` (same property as the marketing site, website ID `38d680a7-28d1-42fd-9fd5-a66702675b88`)

The script is loaded once in `client/index.html`. All custom events go through the thin wrapper in `client/src/analytics.ts`:

```ts
import { track } from "../analytics";
track("event_name", { key: "value" }); // data is optional
```

The wrapper calls `window.umami?.track(...)` — a no-op if the script hasn't loaded yet or is blocked by an ad blocker, so it never throws.

### Events currently tracked

| Event | Where | Properties |
|---|---|---|
| `mode_selected` | `App.tsx` | `mode`: `"solo"` \| `"multiplayer"` |
| `theme_selected` | `App.tsx` | `theme`: theme label string |
| `game_started` | `useGame` | `relationshipType` |
| `event_intro_viewed` | `useGame` | `age`, `eventNumber` |
| `conversation_started` | `useGame` | `age` |
| `conversation_ended` | `useGame` | `age`, `eventNumber`, `messageCount` |
| `epilogue_reached` | `useGame` | — |
| `game_completed` | `useGame` | — |
| `guardian_accepted` | `GuardianScreen` | — |
| `guardian_not_ready` | `GuardianScreen` | — |
| `portrait_loaded` | `ChildPortrait` | `ageBucket`, `attempts` |
| `portrait_failed` | `ChildPortrait` | `ageBucket` |
| `wait_question_shown` | `useWaitQuestions` | `questionId`, `wait` |
| `wait_question_answered` | `useWaitQuestions` | `questionId`, `wait` |
| `wait_question_skipped` | `useWaitQuestions` | `questionId`, `wait` |
| `followup_offer_shown` | `FollowupOffer` | — |
| `followup_opted_in` | `FollowupOffer` | — |
| `followup_withdrawn` | `FollowupOffer` | — |
| `followup_skipped` | `FollowupOffer` | — |
| `error_occurred` | `useGame` | `step` |

To add a new event, import `track` and call it. No registration needed — Umami creates new event names on first receipt.

---

## Langfuse — LLM observability

**Dashboard:** `https://langfuse.multiversegames.ai`

Every LLM call (the real router, or the dev harness's canned model) is wrapped by `TracedLLMClient` (`server/src/observability/langfuse.ts`). It records a trace + generation per call with the prompt, output, token counts, and metadata tags.

### Configuration

Set these in `/opt/raising-intelligences/.env` on the server (already present in production):

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://langfuse.multiversegames.ai   # self-hosted instance
```

If either key **or** `LANGFUSE_HOST`/`LANGFUSE_BASEURL` is missing, `TracedLLMClient` becomes a transparent pass-through — no network calls, no errors. Local dev works without any Langfuse config. The host is deliberately required (not optional): the Langfuse SDK defaults to Langfuse Cloud when no host is given, and this project only ever wants traces going to the self-hosted instance above (see issue #140).

### What gets traced

Each LLM call produces one **trace** containing one **generation** with:
- full system prompt and message history sent to the model (redacted as below)
- the raw text response
- token usage and cost (from OpenRouter's response)
- error level if the call threw

**Tags on every trace:**
- `game_id:<id>`: the game the call was made for. Always present (see "Which game a call belongs to").
- `llm_role:<role>`: the role in `model-config.ts` (`kid_family_chat`, `kid_sidebar`, `kid_adult_chat`, `world_manager`, `psychologist`, `memory_summarizer`, `epilogue`, `report_card`, `album`, `personality_seed`, `gender_inference`, `moment_comparison`, `safety_check`, `psychologist_consult`, `family_therapist`, `cps_caseworker`). Filter by role in the Langfuse UI to compare quality across roles or spot regressions after a model swap.
- `hosted_no_analysis`: the game was played at a host-tools meetup (`observability/hosted-analysis.ts`). Bulk readers drop it unless the game is on the analysis allow-list.
- `child_safety_hold`: the game has a child-safety case (`observability/child-safety-exclusion.ts`). Added to later traces from the start, and to earlier traces of the game by `holdGameTraces`, which finds them by their `game_id:<id>` tag. Bulk readers drop them.

**Redaction:** the `personality_seed` role's prompt embeds both parents' raw confessional text (see `game/personality.ts`), and the world manager's prompt can carry one confessional in its "pressure point" section. Both are replaced with length-only placeholders before anything is sent (`redactConfessionalText`, `redactPressurePoint` in `observability/langfuse.ts`).

### Which game a call belongs to

The server has one `TracedLLMClient` (`traceAppLlm` in `server/src/index.ts`), shared by every game. It learns the game from the async context (`observability/trace-context.ts`), which is set where work for a game enters the server:
- the first socket middleware in `socket/handlers.ts` (the socket's game; for `JOIN_GAME`, the game it names);
- the `/api/game/:id` middleware in `app.ts`, for every REST route under it;
- game creation in `routes/game.ts` (`POST /game` isn't under `/api/game/:id`).

Everything that runs from there (awaits, timers, fire-and-forget work such as the scene prefetch) is traced under that game. `withChildSeed(gameId)` and `withContext({ gameId })` scope a client explicitly.

**Fail closed.** A call with no game, or whose client names a different game from the context, still runs, but its trace is never sent; the server logs `llm_trace_refused_no_game_id` or `llm_trace_refused_game_mismatch` (and reports it to GlitchTip). A new LLM call site that runs outside these entry points shows up there, not as an untagged trace. `tests/langfuse-game-id-production-path.test.ts` plays meetup, invite, held, intervention-ladder and REST games through the real handlers with a Langfuse stand-in (`tests/helpers/langfuse-sink.ts`) and asserts one trace per model call, each naming its game.

**Before 2.12.2** no trace carried `game_id` (the shared client had empty metadata and nothing scoped it), so neither `hosted_no_analysis` nor `child_safety_hold` was ever applied. Bulk readers (`scripts/model-search.ts`, the ri-devlog skill) therefore use only traces that carry a `game_id:<id>` tag (`gameTaggedTraceIds`).

**Where the readers may use hosted games (2.16.2).** The ri-devlog skill drops every `hosted_no_analysis` trace, allow-listed or not: no meetup game is ever in a blog post. `scripts/model-search.ts` may use allow-listed games, and sends every replayed prompt with OpenRouter's `provider: {data_collection: "deny"}` (`benchmarkRequest` in `hosted-analysis.ts`), so the prompts go only to providers that don't store or train on them, as the studio-learning card promises.

### Shutdown flushing

`flushLangfuse()` is called on `SIGTERM` and `SIGINT` in `server/src/index.ts` so buffered traces aren't dropped on container restart.

---

## Admin dashboard — game-level observability

**URL:** `https://multiversegames.ai/raising-intelligences/admin`

The admin dashboard is a built-in read-only view of game data in Postgres. It answers "are people completing games" without querying the database directly. It requires a Bearer token (`ADMIN_TOKEN` env var) and only works in Postgres mode.

### Setup

Add `ADMIN_TOKEN` to the server's `.env`:

```
ADMIN_TOKEN=your-secret-token-here
```

If `ADMIN_TOKEN` is unset, all admin endpoints return `503 Service Unavailable`. If `DATABASE_URL` is also unset (in-memory mode), the admin routes are not mounted at all.

### Pages

**Overview** — stat cards showing total, active, completed, and abandoned game counts. A game is "abandoned" if it has no endgame and `games.updated_at` is older than 7 days.

**Game list** — all games sorted by last activity, filterable by status (active, completed, abandoned). Client-side name filter on the current page. Pagination at 25 games per page.

**Game detail** — drill into a single game:
- Status bar: phase, progress (N/total events), duration, relationship type
- Players table (who joined, display names)
- Events table with per-event message counts (parent1, parent2, kid)
- Sidebar usage flags per parent
- Identity evolution: collapsible snapshots showing the identity document after each event
- Current identity document
- Endgame section (epilogue + report card) for completed games
- LLM cost: deferred (shows "coming soon" — no `llm_usage` table yet)

### Architecture

```
client/src/
  components/admin/
    AdminApp.tsx          # login, navigation, state-based routing
    Overview.tsx          # stat cards
    GameList.tsx           # filterable, paginated game table
    GameDetail.tsx         # full game drilldown
  hooks/
    useAdminApi.ts        # fetch wrapper with Bearer token auth

server/src/
  routes/admin.ts         # Express routes + requireAdmin middleware
  db/admin-queries.ts     # AdminQueries interface, PgAdminQueries, InMemoryAdminQueries
  db/migrations/006-admin-indexes.sql  # performance indexes on games table
```

**Auth flow:** The client prompts for a password, sends it as a `Bearer` token to `/api/admin/overview`. If the server returns 200, the token is stored in `sessionStorage` and used for all subsequent requests. Logout clears `sessionStorage`.

**Data layer:** `AdminQueries` is a read-only interface separate from `GameRepository` (SRP — admin reads don't touch the write-path game state). `PgAdminQueries` runs raw SQL against the existing `games`, `players`, `events`, `messages`, `identity_snapshots`, and `endgames` tables. `InMemoryAdminQueries` is used in tests.

### API endpoints

All endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

The one write endpoint is `DELETE /api/admin/games/:id` (204, or 404 for an unknown game): it erases a game and everything keyed to it, through the same code as the player's own `DELETE /api/game/:id`. It is used when a player asks staff to delete their game.

`DELETE /api/admin/users/:userId` (200 with `{ deletedGameIds }`, 400 for a malformed id) erases everything attached to one user id when that person asks staff: every game linked to it (user_games), every game where it holds a seat (players.user_id or a verified players.campus_sub), solo games created under it as a verified campus id (games.campus_sub), then the user's user_games links and album partners. Each game goes through the same deletion as above, so child-safety flag evidence not yet in the vault is moved into the vault first, and a game is not deleted while the vault is unavailable (the request fails with 500 and can be retried). Vault cases are never erased by this route. A game shared with a co-parent is deleted for both. There is deliberately no self-service version: user ids are client-claimed, so the server cannot verify that a caller owns one.

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/admin/overview` | `{ totalGames, activeGames, completedGames, abandonedGames }` |
| GET | `/api/admin/games?status=&limit=&offset=` | `{ games: GameSummary[], total: number }` |
| GET | `/api/admin/games/:id` | `GameDetail` (or 404) |

### Umami events added for admin analytics

| Event | Where | Properties |
|---|---|---|
| `player_joined` | `useMultiplayer.ts` | `game_id` |
| `sidebar_used` | `MultiplayerGame.tsx` | `game_id` |

These complement the existing Umami events (listed above) to give funnel visibility into multiplayer engagement.
