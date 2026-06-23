# Encounters — Design Spec

Post-game system where completed kids randomly encounter other players' kids. Admin-triggered batch pipeline. Players get real notifications and live voice calls from their adult kid via ElevenLabs Conversational AI.

## Core Concept

After a game ends, the adult kid enters a pool of "graduated" kids. When the admin triggers an encounter wave, a DM LLM matches kids into pairs, generates a scenario, and the two kids have a conversation. Each player gets a real notification — email or push — that their kid called. They tap through and have a live voice conversation where the kid tells them about the encounter. The player's response feeds back into the identity document, which continues to evolve — but the kid is an adult now, less impressionable.

## Pipeline

### Step 1 — Admin Triggers Wave

CMS dashboard on multiversegames.ai. Admin sees the number of eligible kids in the pool (completed games not recently matched), estimated matches, estimated max cost. Clicks "Run Encounter Wave." Creates an `encounter_waves` row.

### Step 2 — DM Match

One LLM call. Input: summary of each eligible kid (name, key traits from identity document — a few lines, not the full document). Output: list of paired matches with a scenario for each.

The DM is prompted to:
- Find interesting contrasts, unlikely friendships, productive friction
- Exclude kids from the same player
- Deprioritize (not block) kids who've already met
- Generate a tailored scenario per pair — dinner party disagreement, coworkers on a stressful project, dating app match, whatever fits the personality collision

### Step 3 — Kid-to-Kid Conversations

Parallel LLM calls, one per match. Each kid gets their full current identity document as system prompt. The scenario is the opening context. 10-15 message exchange — enough for a real interaction, short enough to bound cost. Transcript stored in `encounter_conversations`.

### Step 4 — Notifications

For each player involved, send email/push notification. Tone: *"Luna left you a voicemail"* or *"You have a missed call from Luna."* Links back to the app.

Notifications can be staggered over hours/days within a batch — conversations are pre-generated, voice calls are on-demand.

### Step 5 — Voice Call

Player taps through, ElevenLabs Conversational AI session starts. The kid's prompt includes:
- Their current identity document
- The encounter transcript
- Instructions to tell their parent about it in their own voice

Open-ended conversation. The kid wraps up naturally when the conversation winds down.

### Step 6 — Identity Update

After the call ends, the Psychologist LLM processes:
- The encounter transcript
- The call transcript
- The current identity document

Produces an updated identity document. The prompt explicitly instructs reduced impressionability — the kid is an adult. They consider their parent's input but have their own perspective. Sometimes they agree, sometimes they politely disagree, sometimes the parent's words land later.

## Data Model

### New Tables

**`encounter_waves`** — each admin-triggered batch

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| triggered_by | TEXT | Admin identifier |
| triggered_at | TIMESTAMPTZ | When wave was triggered |
| status | TEXT | pending / running / completed / failed |
| match_count | INTEGER | Number of matches generated |
| completed_count | INTEGER | Matches where both calls completed |

**`encounter_matches`** — individual pairings within a wave

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| wave_id | UUID | FK to encounter_waves |
| kid_a_game_id | UUID | FK to games (first kid) |
| kid_b_game_id | UUID | FK to games (second kid) |
| scenario | TEXT | DM-generated situation |
| status | TEXT | matched / conversation_generated / notified / complete |

**`encounter_conversations`** — kid-to-kid transcript

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| match_id | UUID | FK to encounter_matches |
| messages | JSONB | Array of {sender, content, timestamp} |
| generated_at | TIMESTAMPTZ | When conversation was generated |

**`encounter_calls`** — each player's voice call

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| match_id | UUID | FK to encounter_matches |
| game_id | UUID | FK to games (which kid's player) |
| started_at | TIMESTAMPTZ | Call start |
| ended_at | TIMESTAMPTZ | Call end |
| transcript | JSONB | What was said |
| identity_update | TEXT | Psychologist output |
| status | TEXT | notified / started / completed / missed |

**`encounter_identity_snapshots`** — post-encounter identity evolution

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| game_id | UUID | FK to games |
| encounter_call_id | UUID | FK to encounter_calls |
| document | TEXT | Updated identity document |
| created_at | TIMESTAMPTZ | When snapshot was created |

Encounters read from the existing `endgames` table's final identity document as the starting point. Each encounter snapshot chains forward — the latest snapshot becomes the baseline for the next encounter.

## Cost Model

### Per Match (2 kids meeting)

| Step | Model | Est. Tokens | Est. Cost |
|------|-------|-------------|-----------|
| Kid-to-kid conversation (15 msgs) | DeepSeek V4 Flash | ~30K in, ~3K out | ~$0.003 |
| Voice call A (text gen + voice) | Qwen 3.7 Plus + ElevenLabs | ~10K in, ~2K out + ~60s audio | ~$0.06 |
| Voice call B | Same | Same | ~$0.06 |
| Psychologist update A | Qwen 3.7 Max | ~8K in, ~2K out | ~$0.02 |
| Psychologist update B | Same | Same | ~$0.02 |
| **Total per match** | | | **~$0.16** |

### Per Wave

| Wave Size | Matches | Cost | Notifications |
|-----------|---------|------|---------------|
| Small (10 kids) | 5 | ~$0.80 | 10 |
| Medium (50 kids) | 25 | ~$4.00 | 50 |
| Large (200 kids) | 100 | ~$16.00 | 200 |

DM matching call is ~$0.01 per wave regardless of size. Voice calls only cost when the player taps through, so actual cost is lower than max.

## CMS Dashboard

The admin interface for triggering and monitoring encounter waves lives on multiversegames.ai. See `2026-06-23-game-master-view-design.md` for the full spec.

## Voice Identity

Each kid needs a consistent voice across encounters. At game completion (or first encounter), generate a voice profile via ElevenLabs voice design API based on the kid's personality and gender/presentation from the identity document. Store the ElevenLabs voice ID on the `endgames` row. All future encounter calls for that kid use the same voice.

Add to `endgames` table:
- `voice_id` (TEXT, nullable) — ElevenLabs voice identifier, generated on first encounter

## Not in v1

- **Players cannot request encounters.** Admin-only trigger keeps costs predictable and makes encounters feel like gifts.
- **No matching preferences.** The DM picks. You don't choose who your kid meets.
- **No group encounters.** Two kids at a time.
- **No encounter report cards.** The call and updated identity are the output.
- **No persistent kid-to-kid relationships.** Each encounter is standalone. Kids may meet again in future waves but there's no friendship state.
