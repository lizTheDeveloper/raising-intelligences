# Analytics Dashboard — Design Spec

Admin dashboard on multiversegames.ai showing game health, per-game detail, and cost tracking. Build this first — validates whether the encounters feature has a viable pool before investing in it.

Umami handles aggregate metrics (funnel, trends, overview numbers) via custom event tracking. This dashboard focuses on what Umami can't see: individual game state, LLM cost breakdowns, and the operational detail needed to run the game.

## Where It Lives

A section within the multiversegames.ai CMS, alongside the Game Master View. Admin-only.

## Umami Integration

Track these custom events in the game client/server so Umami handles the funnel and trends:

| Event | Properties | When Fired |
|-------|-----------|------------|
| `game_created` | game_id, relationship_type | Game created in lobby |
| `player_joined` | game_id | Second player joins |
| `event_started` | game_id, event_number, age | Each life event begins |
| `event_completed` | game_id, event_number, duration_seconds | Family chat + debrief done |
| `sidebar_used` | game_id, event_number, player | Player pulls kid aside |
| `game_completed` | game_id, total_events, duration_minutes | Report card generated |
| `game_abandoned` | game_id, last_event_number, idle_days | 7+ days idle, not completed |
| `report_shared` | game_id, share_token | Report card link copied/shared |

This gives you funnel (created → joined → event N → completed), trends over time, completion rate, and drop-off analysis — all in Umami's existing UI with no custom build.

## Pages (Custom Dashboard)

### Overview

Lightweight summary for things Umami doesn't track — cost and live state. Date range selector.

**Numbers:**
- Active games right now (in progress)
- Completed games (all time / in range)
- Encounter-eligible pool size (completed, not recently matched)
- Total LLM cost (in range)
- Average cost per game
- Cost per completed game vs cost per abandoned game

**Cost trend chart:** daily/weekly LLM spend, broken down by model role.

### Game List

Searchable, sortable table of all games.

| Column | Description |
|--------|-------------|
| Game ID | Link to game detail |
| Child Name | What they named the kid |
| Players | Display names / emails if available |
| Status | Current phase |
| Current Event | How far they got |
| Created | When game was created |
| Last Activity | Last state transition |
| Duration | Time from creation to completion or last activity |
| Cost | Total LLM cost so far |

Filter by: status (active / completed / abandoned), date range, player.

"Abandoned" = no activity for 7+ days and not completed. Threshold configurable.

### Game Detail

Drill into a single game. Everything the admin needs to understand what happened.

- **Status bar:** phase, current event number, total events, time elapsed
- **Timeline:** visual progression through events with timestamps and durations
- **Event list:** each event's description, age, message count, sidebar usage, time spent
- **Identity evolution:** snapshot at each event — show the progression, highlight what changed
- **Cost breakdown:** LLM calls by role, tokens, cost per event
- **Player activity:** message counts per player, sidebar usage, debrief engagement
- **Endgame (if completed):** epilogue preview, report card preview, adult conversation count

## Data Sources

All data comes from existing tables — no new tracking needed:

| Metric | Source |
|--------|--------|
| Game status/progress | `games` table (phase, current_event_number) |
| Completion | `endgames` table existence |
| Drop-off point | `games.phase` + `games.current_event_number` for non-completed games |
| Player info | `players` table |
| Event progression | `events` table |
| Message activity | `messages` table |
| Identity evolution | `identity_snapshots` table |
| LLM costs | `llm_usage` table |
| Time metrics | Timestamps on games, events, messages |

## Technical Notes

- Read-only views against the existing game database
- No new tables needed — this is pure reporting on existing data
- Queries may need a few indexes for performance (e.g. `games` by status, `llm_usage` by game_id)
- The abandoned game threshold (7 days idle) should be a config value
- Dashboard should load fast — pre-aggregate the overview numbers if query performance becomes an issue, but start with live queries
- This dashboard feeds into the Game Master View — the encounter pool is essentially "completed games" filtered from the same data
