# Family Photo Album

## Summary

A post-game family album for logged-in users that lets them browse all the kids they've raised, organized by co-parenting partner. Each kid gets a full scrapbook page with their portrait timeline, key moments with illustrations, the epilogue, and the report card. Solo games get a generated fictional co-parent inferred from gameplay context.

The album is accessible from the start screen ("my family" button for logged-in users) and offered as the next step after the report card.

Login (Matrix auth) is required — the album is a reason to create an account.

## Data Model

### New tables

**`album_partners`**

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | `DEFAULT gen_random_uuid()` |
| `user_id` | TEXT NOT NULL | Matrix user ID |
| `partner_name` | TEXT NOT NULL | Real display name (multiplayer) or LLM-generated name (solo) |
| `partner_type` | TEXT NOT NULL | `'real'` or `'generated'` |
| `relationship_summary` | TEXT NOT NULL DEFAULT '' | 1-2 sentence co-parenting dynamic blurb |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Unique constraint on `(user_id, partner_name, partner_type)` so the same real partner doesn't create duplicate rows across games.

**`album_moments`**

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | `DEFAULT gen_random_uuid()` |
| `game_id` | UUID NOT NULL FK → games | |
| `age` | INTEGER NOT NULL | Which life stage this moment came from |
| `title` | TEXT NOT NULL | Short label, e.g. "The pasta incident" |
| `description` | TEXT NOT NULL | 1-2 sentence summary |
| `moment_type` | TEXT NOT NULL | `'funny'`, `'tender'`, `'conflict'`, or `'milestone'` |
| `image_path` | TEXT | Relative path to generated illustration, nullable if generation failed |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | Ordering within the scrapbook |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

### Schema changes to existing tables

**`user_games`** — add column:

| Column | Type | Notes |
|--------|------|-------|
| `partner_id` | UUID FK → album_partners | Nullable for legacy games without album data |

### Existing tables used (no changes)

- `games` — child_name, relationship_type
- `endgames` — epilogue, report_card
- `players` — display_name for the other player in multiplayer games
- Portraits on disk at `portraits/{gameId}/age-{XX}.png` — all 5 age-stage portraits (age-03, age-07, age-12, age-16, age-20)

## Album Generation Flow

Runs as a new step in the endgame flow, immediately after `saveEndgame` (after the report card is generated). Non-blocking — if it fails, the game still completes normally.

### Step 1: Text extraction (nice model)

A single LLM call using the same model tier as the epilogue and report card. Input: full message history + identity document + epilogue + report card.

Extracts via structured output:
- **Partner info (solo games only):** A name and 1-2 sentence relationship summary, inferred from the child's chat messages, identity document, and life events. For multiplayer games, partner name comes from the `players` table and the relationship summary is generated.
- **Key moments (4-6):** Each with a title (short, evocative label), description (1-2 sentences), the age it happened at, a type category (funny/tender/conflict/milestone), and a visual prompt (one sentence describing the scene for illustration generation).

### Step 2: Moment illustrations (cheap image model)

For each extracted moment, generate a small illustration using `gpt-5-image-mini` via OpenRouter (same pipeline as the existing portrait system). The prompt uses the visual prompt from step 1, wrapped in the game's lo-fi anime aesthetic style directives.

Images are saved to `portraits/{gameId}/moment-{NN}.png` alongside the existing age portraits.

Image generation runs in parallel across moments. Individual failures are tolerated — the moment still appears in the scrapbook, just without the illustration.

### Step 3: Persist

1. Upsert `album_partners` row (find-or-create by user_id + partner_name + partner_type)
2. Save `album_moments` rows with image paths
3. Update `user_games.partner_id` to link the game to the partner

### Legacy games

Completed games that predate this feature will not have album data. They appear in the album with:
- All existing portraits
- Epilogue and report card text (from `endgames` table)
- No extracted moments or partner info
- Grouped under an "Other" or "Uncategorized" partner section

A future backfill script could retroactively generate album data for legacy games by replaying the extraction step against stored messages.

## API Endpoints

### `GET /api/user/:userId/album`

Returns the full album structure for a user.

Response:
```json
{
  "partners": [
    {
      "id": "uuid",
      "partnerName": "Alex",
      "partnerType": "real",
      "relationshipSummary": "Co-parents who disagreed on everything but made it work.",
      "kids": [
        {
          "gameId": "uuid",
          "childName": "Luna",
          "createdAt": 1719000000000,
          "hasAlbumData": true
        }
      ]
    }
  ],
  "unlinkedKids": [
    {
      "gameId": "uuid",
      "childName": "Kai",
      "createdAt": 1718000000000,
      "hasAlbumData": false
    }
  ]
}
```

### `GET /api/user/:userId/album/kid/:gameId`

Returns the full scrapbook data for one kid.

Response:
```json
{
  "childName": "Luna",
  "partnerName": "Alex",
  "partnerType": "real",
  "relationshipSummary": "...",
  "portraits": [
    { "age": 3, "url": "portraits/uuid/age-03.png" },
    { "age": 7, "url": "portraits/uuid/age-07.png" },
    { "age": 12, "url": "portraits/uuid/age-12.png" },
    { "age": 16, "url": "portraits/uuid/age-16.png" },
    { "age": 20, "url": "portraits/uuid/age-20.png" }
  ],
  "moments": [
    {
      "age": 3,
      "title": "The pasta incident",
      "description": "Refused to eat anything that wasn't shaped like a star.",
      "momentType": "funny",
      "imageUrl": "portraits/uuid/moment-01.png"
    }
  ],
  "epilogue": "...",
  "reportCard": "..."
}
```

## Client-Side Design

### New components

**`FamilyAlbum.tsx`** — top-level album view, manages navigation state:
- `albumView: 'partners' | 'kids' | 'scrapbook'`
- `selectedPartnerId` and `selectedGameId` for drill-in

**`PartnerCards.tsx`** — grid of partner cards. Each card shows:
- Partner name
- Subtle indicator for generated vs real partner (italic for generated)
- Number of kids
- Thumbnail of most recent kid's latest portrait

**`KidsList.tsx`** — list of kids for a selected partner. Each entry shows:
- Kid's name
- A small portrait thumbnail (most recent age portrait available)

**`Scrapbook.tsx`** — full vertical scroll for one kid:
- Header: kid name, partner name as subtitle
- Portrait timeline: horizontal strip of all 5 age portraits, scrollable on mobile, each labeled with age
- Moments: vertical feed of moment cards (illustration + age badge + title + description + type indicator)
- Epilogue: "years later" narrative text
- Report card: rendered with existing `ReportCard` component

### Navigation

State-driven, no router. Back arrows navigate up the stack:
- Scrapbook → Kids list → Partner cards

### Entry points

- **Start screen:** "my family" button visible only for logged-in users, placed between the mode buttons and the auth section
- **Post-report-card:** "view your family" button below the report card

### Styling

Follows existing aesthetic — dark background, muted warm palette, lo-fi feel. The album should feel like a cozy scrapbook, not a data dashboard.

## Endgame Engine Changes

`EndgameEngine` gets a new method:

```
async generateAlbumData(
  state: GameState,
  epilogue: string,
  reportCard: string
): Promise<{
  partnerName: string;
  relationshipSummary: string;
  moments: Array<{
    age: number;
    title: string;
    description: string;
    momentType: string;
    visualPrompt: string;
  }>;
}>
```

Called after `generateReportCard` completes. Uses the same LLM client. Returns structured data that the caller persists to DB and uses to trigger moment illustration generation.

## Error Handling

- Album generation failure does not block game completion
- Individual moment image failures are tolerated (moment shows without illustration)
- Album API returns graceful partial data for legacy games
- If a user has no completed games, the album shows an empty state: "No kids yet. Play a game to start your family album."
