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
| `error_occurred` | `useGame` | `step` |

To add a new event, import `track` and call it. No registration needed — Umami creates new event names on first receipt.

---

## Langfuse — LLM observability

**Dashboard:** `https://langfuse.multiversegames.ai`

Every call through `OpenRouterLLMClient` is wrapped by `TracedLLMClient` (`server/src/observability/langfuse.ts`). It records a trace + generation per call with the prompt, output, token counts, and metadata tags.

### Configuration

Set these in `/opt/raising-intelligences/.env` on the server (already present in production):

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://langfuse.multiversegames.ai   # self-hosted instance
```

If either key is missing, `TracedLLMClient` becomes a transparent pass-through — no network calls, no errors. Local dev works without any Langfuse config.

### What gets traced

Each LLM call produces one **trace** (tagged with `game_id`, `event_number`, `llm_role`) containing one **generation** with:
- full system prompt and message history sent to the model
- the raw text response
- token usage and cost (from OpenRouter's response)
- error level if the call threw

The `llm_role` tag maps to the roles in `model-config.ts`: `kid_family_chat`, `kid_sidebar`, `kid_adult_chat`, `world_manager`, `psychologist`, `epilogue`, `report_card`. Filter by role in the Langfuse UI to compare quality across roles or spot regressions after a model swap.

### Adding context to traces

The server creates a root `TracedLLMClient` in `server/src/index.ts` and passes it to the engines. To carry game/event context into traces, call `.withContext()` before passing the client to an engine method:

```ts
const tracedWithContext = llm.withContext({ gameId: state.id, eventNumber: state.eventNumber });
```

The resulting client shares the same inner `OpenRouterLLMClient` (stateless) but stamps every trace it produces with the provided metadata.

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
