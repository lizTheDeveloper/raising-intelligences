# Raising Intelligences — Distributed Systems Architecture

**Status:** Draft
**Date:** 2026-06-22
**Companion Spec:** `2026-06-22-raising-intelligences-design.md`

## Overview

This spec addresses the distributed systems concerns for Raising Intelligences: failure modes, resilience, cost management, scaling, and operational readiness. The game design spec defines what the system does; this defines how it survives production.

## Architecture Principles

1. **LLM calls are the critical path** — everything else (chat, state, persistence) is fast and cheap. Design around LLM latency and failure.
2. **Cost is existential** — server-absorbed API costs mean every wasted call is money lost. Optimize aggressively.
3. **Games are long-lived** — a game spans hours or days. State loss is unacceptable.
4. **Two-player constraint simplifies consistency** — no complex multi-party coordination, but disconnect handling is critical.

## LLM Layer — Open Router

### Provider Strategy

Open Router provides a single API endpoint with automatic routing to multiple LLM providers (Anthropic, OpenAI, Google, etc.). This enables:

- **Model selection by role:**
  - **Kid** — expensive, streaming-capable model (e.g., Claude Sonnet, GPT-4o). User-facing, latency-sensitive, needs personality and natural language. Cost per call ~$0.01-0.05.
  - **World Manager** — mid-tier model (e.g., Claude Haiku, GPT-4o-mini). Non-streaming, can tolerate higher latency. Cost per call ~$0.002-0.01.
  - **Psychologist** — expensive model (Claude Sonnet/Opus). Slow but non-user-facing, can batch. Cost per call ~$0.05-0.15.
  
- **Fallback routing:** If primary model is unavailable, Open Router automatically retries with fallback providers. Client-side circuit breaker still needed.

- **Cost optimization:** Cache World Manager event generation (similar events can reuse templates), batch Psychologist calls when possible, use cheaper models for retry attempts.

### Cost Budget & Monitoring

**Estimated cost per game:**
- ~10-12 events × (1 World Manager + ~15 Kid calls + 1 Psychologist) = 150-240 LLM calls
- Adult conversations: ~2-3 conversations × 12 messages = ~50 Kid calls
- Endgame: ~5-10 calls
- **Total: ~200-300 calls/game, estimated $5-15/game**

**Controls:**
- Per-game token budget: alert at 80% of estimated cost, hard stop at 100%
- Langfuse dashboard tracking: cost/game, cost/player, cost/event
- Anomaly detection: if cost/game exceeds 2× historical average, alert immediately
- Daily cost report: total API spend, games played, cost per game

### Resilience Patterns

**Circuit breaker (per model):**
- If Open Router returns errors for model X > 5 times in 60 seconds, circuit opens
- Open circuit: pause new games, queue existing LLM calls, show user-friendly message ("The child is thinking... please wait")
- Half-open state: allow one test call after 30 seconds; if successful, close circuit

**Timeout + retry with idempotency:**
- All LLM calls: 30-second timeout, exponential backoff retry (3 attempts: 1s, 5s, 20s)
- Idempotency key per LLM call: `{game_id}-{event_number}-{role}-{call_purpose}` (e.g., `abc123-2-world_manager-event_gen`)
- Prevents double-charges on retry, ensures same input produces same output

**Bulkhead isolation:**
- Separate thread pool / connection pool per game
- One slow LLM call (e.g., Psychologist taking 60 seconds) doesn't block other games
- Per-game timeout: if any LLM call exceeds 2× expected duration, alert

**Graceful degradation:**
- World Manager failure: show manual event selection from predefined set, continue game
- Psychologist failure: queue identity update, continue with previous identity doc, warn user ("The child's memories are still forming...")
- Kid failure: show "The child is quiet right now" placeholder, retry after delay

## State Management

### In-Memory vs. Persistent

**In-memory (authoritative for active games):**
- Game state machine (lobby → playing → event N → debrief → endgame)
- Current event context (World Manager output, chat messages)
- WebSocket connection state (who's connected, sidebar state)
- Pending LLM calls (debounce timers, in-flight requests)

**Postgres (write-through, source of truth for completed games):**
- All data written synchronously after every state change
- Schema: `games`, `players`, `events`, `messages`, `identity_snapshots`, `endgames`
- On server restart: reconstruct in-memory state from latest Postgres checkpoint

**Checkpoint strategy:**
- Every event completion: persist full game state (event number, identity doc, all messages)
- Every message: append to Postgres immediately (prevents loss if server crashes mid-event)
- Every WebSocket message: write to `messages` table before acknowledging to client

**Reconnect flow:**
1. Player reconnects via shareable link
2. Server looks up `game_id` from link token
3. Load latest checkpoint from Postgres (last completed event + all messages)
4. Reconstruct in-memory state
5. Re-establish WebSocket connections
6. Resume game from last known state

### Consistency Guarantees

**Read-your-writes:** After player sends message, subsequent reconnect shows that message
**Eventual consistency for LLM calls:** Kid response appears after debounce + LLM latency (2-5 seconds); acceptable for conversational flow
**Strong consistency required:**
- Message ordering within a chat mode (shared → private → debrief)
- Identity document updates (Psychologist output must not be lost or duplicated)
- Event transitions (can't skip events or process same event twice)

## Transaction Boundaries

### Atomic Operations

**Message send:**
```
1. Player sends message via WebSocket
2. Write to Postgres `messages` table (synchronous)
3. Acknowledge to player (WebSocket confirmation)
4. Trigger Kid LLM call (async, with idempotency key)
5. When LLM responds, write to Postgres (step 2 repeat)
6. Send Kid response via WebSocket
```
If step 2 fails: reject message, show error ("Message failed to send, please retry")
If step 4 fails: message is persisted but no Kid response yet; retry with idempotency key

**Event transition:**
```
1. Debrief ends (both players ready)
2. Call World Manager to generate next event (synchronous)
3. On success: write event to Postgres, update game state
4. Notify players of new event via WebSocket
5. Start family chat phase
```
If step 2 fails: fall back to predefined event, alert ops team
If step 3 fails: retry 3× with idempotency key; if still fails, pause game, show error

**Psychologist processing (after event):**
```
1. Event concludes (message cap reached or natural closure)
2. Gather all messages from event (shared + private)
3. Call Psychologist LLM (async, with idempotency key)
4. On success: write new identity document to `identity_snapshots`, update game state
5. Transition to next event or debrief
```
If step 3 fails: queue identity update, continue with previous identity doc, retry in background
If step 4 fails: retry 3×; if still fails, game continues but identity doc is stale — alert ops

### Outbox Pattern

For async LLM calls that must not be lost:

```sql
CREATE TABLE llm_call_outbox (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(50) NOT NULL,  -- 'kid', 'world_manager', 'psychologist'
  input_context JSONB NOT NULL,
  status VARCHAR(20) NOT NULL,  -- 'pending', 'in_progress', 'completed', 'failed'
  output JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

Flow:
1. Write pending LLM call to outbox (idempotency_key = unique)
2. Async worker picks up pending calls, calls Open Router
3. On success: update outbox status, write output to relevant table
4. On failure: retry with backoff; if max retries exceeded, mark failed, alert ops

This ensures no LLM call is lost, even if server crashes mid-processing.

## Load Management

### Concurrency Limits

- **Max concurrent games:** 100 (adjustable based on LLM rate limits)
- **Max WebSocket connections per game:** 2 (one per player)
- **Max messages per minute per game:** 60 (prevents spam)
- **Max LLM calls per game:** 300 (hard stop at budget limit)

### Backpressure

- **Per-game message queue:** If LLM is slow (>10 seconds), queue parent messages; when LLM responds, process queue in FIFO order
- **Global LLM call queue:** If Open Router rate-limited, queue calls and process at allowed rate
- **Circuit breaker on new games:** If >50 concurrent games AND LLM latency >95th percentile, reject new game creation with "Server at capacity, try again later"

### Connection Management

- WebSocket idle timeout: 5 minutes (kick disconnected players from memory, but state is in Postgres)
- Reconnect window: 24 hours (player can reconnect within 24 hours via shareable link)
- Max session duration: 30 days (game auto-ends if no activity for 30 days)

## Failure Scenarios & Handling

### Server Crash Mid-Game

**Scenario:** Server process dies while event 5 is in progress
**Recovery:**
1. Server restarts
2. Load all active games from Postgres (status != 'ended')
3. For each game: reconstruct state from latest event + messages
4. Re-establish WebSocket listeners (players must reconnect via link)
5. Resume from last checkpoint (event 5 in progress, no message loss)

**Data loss:** None (every message is persisted immediately)
**User experience:** Players see "Reconnecting..." for ~30 seconds, then game resumes

### LLM Provider Outage

**Scenario:** Open Router (or underlying provider) is completely down
**Handling:**
1. Circuit breaker opens after 5 errors in 60 seconds
2. All active games: pause LLM calls, show "The child is thinking..." placeholder
3. New games: rejected with "Try again later"
4. Auto-retry every 5 minutes; when provider recovers, circuit closes
5. Games >24 hours old without activity: send email to players ("We had a technical issue, your game is ready to resume")

**Worst case:** Game paused for hours; players can reconnect and resume when provider is back

### Postgres Unavailable

**Scenario:** Postgres is down for 5 minutes
**Handling:**
1. Message sends: write to in-memory queue, retry Postgres writes with backoff
2. If queue grows unbounded: circuit breaker on message sends, show error to players
3. LLM calls: continue (in-memory state is authoritative), but don't persist results yet
4. When Postgres recovers: flush queue, write all pending messages/LLM outputs
5. If Postgres down >1 hour: pause all games, alert ops, page on-call

**Data loss:** None (in-memory state survives, writes are durable once Postgres is back)
**Risk:** Server crash during Postgres outage = lose in-memory state (mitigated by hourly Postgres backups)

### Identity Document Generation Failure

**Scenario:** Psychologist LLM call fails after 3 retries
**Handling:**
1. Write failure to outbox, mark as 'failed'
2. Continue game with previous identity document
3. Queue background retry (every 10 minutes, up to 1 hour)
4. If still failing after 1 hour: alert ops, pause game, send email to players

**Impact:** Identity document is stale (doesn't reflect latest event), but game continues
**User experience:** Players may notice child behavior doesn't evolve as expected

## Observability

### SLOs

- **Availability:** 99.5% (games not lost, players can reconnect)
- **p95 response time:** Kid messages < 5 seconds (from send to response visible)
- **p99 response time:** Kid messages < 10 seconds
- **Error rate:** <1% LLM calls fail permanently (after retries)
- **Cost per game:** 95th percentile < $15

### Dashboards (Langfuse + Grafana)

**Operational:**
- Concurrent games (real-time)
- WebSocket connections (real-time)
- LLM call latency by role (p50, p95, p99)
- LLM error rate by model
- Postgres query latency
- Message rate per game

**Business:**
- Cost per game (histogram)
- Total API spend (daily)
- Games played (daily/weekly)
- Player retention (% of games completed vs. abandoned)
- Event duration (time per event, p50/p95)

**Alerts:**
- LLM error rate > 5% for 5 minutes
- Concurrent games > 80
- Cost/game > 2× historical average
- p95 response time > 10 seconds for 5 minutes
- Postgres write latency > 100ms for 5 minutes

### Logging & Tracing

- Structured JSON logs with correlation IDs
- Every LLM call traced in Langfuse: input context, model, tokens, latency, cost
- Every game traced from creation to completion: all events, messages, LLM calls
- WebSocket connection lifecycle: connect, disconnect, reconnect
- Error logs with full stack traces, game state, and recent messages

## Deployment & Schema Evolution

### Database Migrations

- Versioned migrations (e.g., `migrations/001_initial_schema.sql`, `002_add_player_stats.sql`)
- All migrations: reversible, tested against staging data
- Zero-downtime migrations: add columns (nullable), then backfill, then add constraints
- Never drop columns in a single deploy: first stop using, deploy, then drop in next deploy

### Deployment Strategy

**Problem:** Server restart = lose all in-memory state
**Solution:**
1. **Graceful shutdown:** on deploy, wait for all active LLM calls to complete, close WebSocket connections with "Server restarting" message, flush in-memory state to Postgres
2. **Blue-green deployment:** spin up new server version, keep old version running, switch traffic when new version is healthy. Old version drains active games.
3. **Multi-server deployment (future):** if scale requires multiple servers, move game state to Redis (not just Postgres) so any server can handle any game. Use Redis pub/sub for real-time coordination.

### Feature Flags

- Game mechanics: test new event types, Psychologist prompts, World Manager logic without full deploy
- Model selection: A/B test different models for Kid/World Manager/Psychologist
- Cost controls: toggle budget alerts, hard stops, model fallbacks

## Testing Strategy

### Unit Tests

- Game state machine transitions (lobby → playing → event → debrief → endgame)
- Message debouncing logic (rapid-fire vs. spaced messages)
- Identity document compression (old material gets summarized correctly)
- LLM call retry logic (timeout, backoff, idempotency)

### Integration Tests

- Full event flow: World Manager → Family Chat → Sidebar → Psychologist → Identity Update
- Multi-game concurrency: 10 games running simultaneously, no cross-contamination
- Disconnect/reconnect: player disconnects during event, reconnects, state is correct
- LLM failure: mock Open Router to return errors, verify circuit breaker and graceful degradation

### Chaos Tests

- Network partition: simulate player disconnect for 5 minutes during event
- LLM provider outage: mock Open Router down for 10 minutes, verify games pause and resume
- Postgres failure: mock Postgres down for 5 minutes, verify message queue and recovery
- Memory pressure: simulate 1000 concurrent games, verify performance doesn't degrade

### Load Tests

- Max concurrent games: 100 games × 2 players = 200 WebSocket connections, 100 active games
- Message rate: 60 messages/minute/game × 100 games = 6000 messages/minute
- LLM call rate: ~20 calls/game × 10 concurrent game transitions = 200 concurrent LLM calls
- Postgres write rate: 6000 messages/minute + identity snapshots = 6100 writes/minute

## Cost Optimization Strategies

### 1. Model Selection

- **Kid:** Claude Sonnet 4 or GPT-4o (expensive but necessary for personality)
- **World Manager:** Claude Haiku or GPT-4o-mini (cheaper, non-streaming)
- **Psychologist:** Claude Sonnet 4 (slow but non-user-facing)

**Estimated savings:** 30-40% vs. using Sonnet for everything

### 2. Caching

- **World Manager events:** cache event templates, reuse for similar scenarios (e.g., "first day of school" can have variations but same core structure)
- **Identity document:** cache in Redis across Psychologist calls (avoid re-sending full doc every time)
- **Kid responses:** cache common responses (greetings, reactions) — but be careful not to make kid feel repetitive

**Estimated savings:** 10-20%

### 3. Batching

- **Psychologist calls:** if multiple sidebars happen in one event, batch all messages into single call (not one call per conversation)
- **Endgame report card:** generate in one large LLM call, not multiple small calls

**Estimated savings:** 5-10%

### 4. Request Deduplication

- **Idempotency keys:** prevent duplicate LLM calls on retry
- **Message coalescing:** if two parent messages arrive within 2 seconds, send both to Kid in one call (debounce already handles this)

**Estimated savings:** 5%

## Security Considerations

### Shareable Link Security

- **Token entropy:** 128-bit random token (e.g., `/game/a7f3k9m2x1b9c4d8e7f6g5h4`) — 2^128 possibilities, brute-force infeasible
- **Link expiration:** links valid for 30 days after last activity, then game auto-ends
- **Revocation:** allow players to revoke and regenerate link (if leaked)
- **Rate limiting:** max 10 join attempts per IP per minute (prevents link guessing)

### Input Validation

- **Message length:** max 2000 characters per message (prevents prompt injection via length)
- **Message content:** basic sanitization (no HTML/script tags), but allow natural language
- **Display name:** max 50 characters, no special characters

### WebSocket Security

- **Origin validation:** only accept WebSocket connections from your domain (prevents cross-site hijacking)
- **Message authentication:** each WebSocket message signed with game token (prevents spoofing)
- **Rate limiting:** max 60 messages/minute per connection (prevents spam)

### LLM Prompt Injection

- **Player messages:** sanitize before including in LLM context (escape special characters, limit length)
- **Identity document:** not directly exposed to players, but still sanitize player inputs that end up in the doc
- **Content moderation:** Kid's system prompt includes content boundaries (no explicit content with child character); rely on LLM's built-in safety

## Future Considerations

### Horizontal Scaling

If game count exceeds single-server capacity:
- Move game state to Redis (not just Postgres write-through)
- Use Redis pub/sub for real-time WebSocket coordination across servers
- Sticky sessions (route player to same server based on game_id hash) for WebSocket stability
- Shard games across servers by game_id (natural partition key)

### Multi-Region Deployment

If latency becomes an issue:
- Deploy in US + EU + Asia
- Route players to nearest region
- Postgres replication across regions (async for read replicas, sync for master)
- LLM calls stay in single region (Open Router handles routing)

### Async Play

If players want to play across sessions (not real-time):
- Email/push notifications when it's your turn
- Allow players to respond on their own schedule (like play-by-email)
- Requires rethinking real-time WebSocket model (or making it optional)

## Appendix: Technology Stack

- **Backend:** Node.js (Express + WebSocket)
- **Database:** Postgres (with Redis for caching/session state if multi-server)
- **LLM:** Open Router (routing to Claude, GPT-4, etc.)
- **Observability:** Langfuse (LLM tracing), Grafana (dashboards), Sentry (error tracking)
- **Hosting:** ??? (not specified — consider Render, Railway, or AWS ECS for container deployment)
- **Domain:** ??? (not specified)
- **CI/CD:** ??? (not specified — consider GitHub Actions for deploy automation)
