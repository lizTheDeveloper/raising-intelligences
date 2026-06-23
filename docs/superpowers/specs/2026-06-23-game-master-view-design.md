# Game Master View — Design Spec

Admin interface on multiversegames.ai for triggering and monitoring encounter waves. This is the "dean's office" — where you decide when to throw orientation week.

Depends on: `2026-06-23-encounters-design.md` (pipeline), `2026-06-23-analytics-dashboard-design.md` (game data feeds into eligibility).

## Where It Lives

A section within the existing multiversegames.ai CMS. Not a standalone app. Accessible to admin users only.

## Pages

### Encounter Pool

The "who's available" view.

- Total eligible kids (completed games, not matched in the current/recent wave)
- Table: kid name, player email, game completion date, number of previous encounters, last encounter date
- Filter by: completion recency, encounter count, player
- Search by kid name or player
- Bulk select/exclude specific kids from the next wave

### Trigger Wave

The action page.

- Shows: eligible count (respecting any exclusions), estimated matches (eligible / 2), estimated max cost (matches x $0.16)
- Optional: limit batch size (e.g. "match the top 20 most recent completions only")
- Optional: stagger notifications over N hours/days
- Confirm button with cost estimate displayed
- After trigger: redirects to wave detail page showing live progress

### Wave History

List of all past waves.

| Column | Description |
|--------|-------------|
| Date | When triggered |
| Matches | Number of pairs |
| Conversations | Generated count |
| Notified | Notifications sent |
| Calls Completed | Players who picked up |
| Calls Missed | Players who didn't |
| Actual Cost | LLM + voice spend |
| Status | Running / completed / failed |

Click through to wave detail.

### Wave Detail

Drill into a single wave.

- Summary stats at top
- Table of matches, each showing:
  - Kid A name + Kid B name
  - Scenario (the DM-generated situation)
  - Conversation status (generated / failed)
  - Player A call status (notified / started / completed / missed)
  - Player B call status (same)
  - Link to view kid-to-kid transcript
  - Link to view call transcript (if completed)
  - Identity update preview (first few lines of psychologist output)

### Match Detail

Single match deep dive.

- The scenario
- Full kid-to-kid conversation transcript
- Player A's call: status, transcript, duration
- Player B's call: status, transcript, duration
- Identity updates for both kids (before/after diff)

## Technical Notes

- Reads from the encounter tables defined in the encounters spec
- Reads game completion data from the existing `games` and `endgames` tables
- The "trigger wave" action calls a server endpoint that kicks off the batch pipeline
- Wave progress updates via polling (simple) or SSE (nicer) on the wave detail page
- No real-time requirements — admin checks back when they want
