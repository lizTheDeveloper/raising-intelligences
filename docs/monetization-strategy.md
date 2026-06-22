# Raising Intelligences — Monetization Strategy

*Prepared 2026-06-22. Based on bottom-up cost analysis, the game design spec, PRD, and implementation plan.*

---

## 1. Cost Structure Analysis

### Correcting the Initial Estimate

The original estimate of "30-50+ API calls per game" significantly undercounts the actual call volume. A bottom-up recount from the game mechanics yields **104-323 LLM calls per game** depending on player behavior. Here is the full breakdown:

### LLM Call Inventory Per Game

| Role | Mechanic | Calls Per Event | Events | Subtotal (Light/Heavy) |
|------|----------|-----------------|--------|------------------------|
| **Kid** — Family Chat | Up to 12 parent msgs/event, kid responds per-message (debounce combines rapid-fire, but each parent message after debounce triggers a call) | 4-12 | 10-12 | **40-144** |
| **Kid** — Sidebars | Each parent can pull kid aside for up to 12 msgs. 0-2 sidebars per event, ~3-12 kid responses each | 0-12 | 10-12 | **0-96** (0 if unused, ~48 typical) |
| **Kid** — Adult Conversations | 2-3 conversations, up to 12 msgs each | 4-12 per convo | 2-3 | **8-36** |
| **World Manager** — Event Generation | 1 per event | 1 | 10-12 | **10-12** |
| **World Manager** — Epilogue | 1 total | — | — | **1** |
| **World Manager** — Adult Convo Scenarios | 1 per scenario | — | — | **2-3** |
| **Psychologist** — Identity Updates | 1 per event | 1 | 10-12 | **10-12** |
| **Report Card** | 1 total | — | — | **1** |
| **Total** | | | | **72-305** |

Player profiles:

| Profile | Description | Estimated Calls |
|---------|-------------|-----------------|
| **Light** | Short conversations (~4 parent msgs/event), no sidebars, 10 events | ~72-90 |
| **Typical** | ~8 parent msgs/event, 1 sidebar every other event, 11 events | ~140-180 |
| **Heavy** | Max messages, both sidebars every event, 12 events, chatty adult convos | ~250-305 |

### Token Economics (the Real Cost Driver)

Output tokens are expensive but predictable. **Input tokens are the dominant and growing cost** because the entire conversation history and identity document are re-sent on every Kid call, and the context window grows with each message.

**Claude Sonnet pricing (current as of mid-2026): ~$3/MTok input, ~$15/MTok output.**

#### Output Token Estimates

| Call Type | Output Tokens Per Call | Calls (Typical) | Total Output Tokens |
|-----------|----------------------|-----------------|---------------------|
| Kid — Family Chat | 100-300 | ~88 | ~17,600 |
| Kid — Sidebars | 100-300 | ~24 | ~4,800 |
| Kid — Adult Convos | 150-400 | ~18 | ~5,400 |
| World Manager — Events | 150-300 | ~11 | ~2,200 |
| Psychologist | 300-500 | ~11 | ~4,400 |
| Epilogue | 800-1,200 | 1 | ~1,000 |
| Report Card | 1,000-2,000 | 1 | ~1,500 |
| **Total Output** | | | **~37,000** |

**Output cost (typical game): ~37K tokens x $15/MTok = ~$0.56**

#### Input Token Estimates (Context Growth Model)

This is where the cost hides. Each Kid call sends: system prompt (~400 tokens) + identity document (~700 tokens by mid-game) + full event conversation history (grows with each message). By the end of event 10, the identity document alone is ~700 tokens, and each event's conversation history can reach ~2,000-3,000 tokens.

| Call Type | Avg Input Tokens Per Call | Calls (Typical) | Total Input Tokens |
|-----------|--------------------------|-----------------|-------------------|
| Kid — early events (1-4) | ~800-1,500 | ~32 | ~36,800 |
| Kid — mid events (5-8) | ~1,500-2,500 | ~32 | ~64,000 |
| Kid — late events (9-12) | ~2,500-3,500 | ~24 | ~72,000 |
| Kid — Sidebars (smaller context) | ~800-1,500 | ~24 | ~27,600 |
| Kid — Adult Convos (full identity doc) | ~3,000-4,500 | ~18 | ~67,500 |
| World Manager — Events | ~1,500-3,000 | ~11 | ~24,750 |
| Psychologist (full transcript + identity doc) | ~2,000-4,000 | ~11 | ~33,000 |
| Epilogue (full identity doc + all events) | ~5,000-8,000 | 1 | ~6,500 |
| Report Card (all snapshots + epilogue + msgs) | ~8,000-15,000 | 1 | ~11,500 |
| **Total Input** | | | **~344,000** |

**Input cost (typical game): ~344K tokens x $3/MTok = ~$1.03**

### Per-Game Cost Summary

| Profile | Input Tokens | Output Tokens | Input Cost | Output Cost | **Total** |
|---------|-------------|---------------|------------|-------------|-----------|
| **Light** | ~200K | ~22K | $0.60 | $0.33 | **$0.93** |
| **Typical** | ~344K | ~37K | $1.03 | $0.56 | **$1.59** |
| **Heavy** | ~600K | ~65K | $1.80 | $0.98 | **$2.78** |

### Cost With Model Tiering (Recommended)

The existing `LLMClient` interface (NFR-051 in the PRD) is already designed to allow implementation swaps. Use this seam for per-role model selection:

| Role | Recommended Model | Why |
|------|------------------|-----|
| Kid (family chat, sidebars) | **Haiku** | High call volume, short outputs, latency-sensitive (streaming). Haiku is ~10-20x cheaper than Sonnet. Quality is sufficient for age-appropriate conversational responses. |
| Kid (adult conversations) | **Sonnet** | Fewer calls, higher-stakes dialogue, players expect more nuance from the grown child. |
| World Manager | **Sonnet** | Needs narrative creativity and awareness of parenting dynamics. Low call count (13-16/game), cost impact is minimal. |
| Psychologist | **Sonnet** | The most critical prompt in the system. Identity document quality drives everything downstream. Low call count. |
| Epilogue | **Sonnet** | 1 call, needs to be good. |
| Report Card | **Opus** | 1 call, the artifact players keep and share. Worth the premium for depth and specificity. |

**Haiku pricing (current): ~$0.25/MTok input, ~$1.25/MTok output.**

| Profile | All-Sonnet Cost | Tiered Cost | Savings |
|---------|----------------|-------------|---------|
| **Light** | $0.93 | ~$0.35 | 62% |
| **Typical** | $1.59 | ~$0.60 | 62% |
| **Heavy** | $2.78 | ~$1.10 | 60% |

**With model tiering, the cost floor per game drops to $0.35-$1.10.** This is the number that determines viable pricing.

### Infrastructure Costs (Non-LLM)

| Item | Estimated Monthly Cost | Notes |
|------|----------------------|-------|
| Managed Postgres (Neon/Supabase free tier) | $0-25 | Free tier covers early growth. ~50MB/1000 games. |
| Server hosting (Fly.io/Railway) | $5-20 | Single container, autosleep when idle |
| Domain + TLS | ~$12/year | Negligible |
| Langfuse (self-hosted or free tier) | $0 | Self-hosted on same server or free cloud tier |
| **Total infra (low traffic)** | **$5-45/month** | |

Infrastructure is negligible until ~500+ concurrent games. **LLM API cost is 95%+ of marginal cost per game.**

---

## 2. Revenue Model Options

### Option A: Pay-Per-Game (RECOMMENDED)

**How it works:** Each game costs a flat fee. One payment unlocks one full playthrough. The person who creates the game pays; the player who joins via link plays free.

**Price point:** $4.99 per game.

| Dimension | Assessment |
|-----------|------------|
| **Covers costs?** | Yes. At $4.99 with tiered models ($0.35-$1.10 cost), gross margin is 78-93%. Even a heavy all-Sonnet game ($2.78) leaves 44% margin. |
| **Indie aesthetic fit** | Strong. "Pay for the experience" is how indie games work. No dark patterns, no recurring charges, no surprise costs. |
| **Friction** | Moderate. Payment before first play is a barrier. Mitigated by the free-first-game offer (see Recommended Strategy). |
| **Co-player dynamics** | Clean. Host pays, guest plays free. The invitation link remains frictionless — critical for the viral loop. |
| **Replay incentive** | Natural. Different partner, different child, different outcome. Each game is genuinely unique. |

**Pros:** Simple mental model. Aligns cost to value. Scales linearly. No ongoing commitment anxiety. Fits the "art game you play with a friend" positioning.

**Cons:** Revenue is lumpy — requires continuous new games. No recurring revenue. First-purchase barrier.

### Option B: Subscription

**How it works:** Monthly fee for unlimited games.

**Why it's wrong for this game:** Subscription works when marginal cost per session is near-zero and engagement is daily/weekly. Raising Intelligences has high marginal cost ($0.35-$1.10/game) and episodic engagement (play a game with a friend, come back weeks later with a different friend). A $9.99/month subscriber who plays 4+ games costs you more than they pay. A subscriber who plays once is overpaying and feels bad about it.

**Verdict: Reject.** The marginal cost structure makes subscription a losing bet on either side of the engagement spectrum.

### Option C: Freemium / Premium Tiers

**How it works:** Free tier gives a truncated experience (4-5 events, no epilogue/adult conversations, basic report card). Premium unlocks the full game.

| Dimension | Assessment |
|-----------|------------|
| **Covers costs?** | Partially. Free tier costs ~$0.15-$0.30 (4-5 events with Haiku). Acceptable as acquisition cost. |
| **Conversion driver** | Strong — players are emotionally invested by event 4-5. The "what happens next" pull is powerful. |
| **Risk** | Cutting the game at event 5 feels like a cliffhanger, not a complete experience. Players may feel manipulated. |

**Verdict: Use as the free-first-game mechanic, not as the permanent model.** First game free, truncated to ~5 events. Full games cost $4.99. This gives players the emotional hook without permanently offering a half-experience.

### Option D: Tip Jar / Pay-What-You-Want

**How it works:** Game is free. Players tip after seeing their report card.

| Dimension | Assessment |
|-----------|------------|
| **Covers costs?** | Unlikely. PWYW conversion rates are 1-5% on the web. At $1.59 cost/game, you need an average tip of $1.67+ per game across *all* players (tippers and non-tippers) to break even. That requires tips of $33-167 from the 1-5% who pay. Not viable. |
| **Indie aesthetic fit** | Excellent. "Pay what it's worth to you" is peak indie. |

**Verdict: Reject as primary model.** Could work as an optional add-on ("leave a tip for the developers") on the report card screen, but cannot be the revenue foundation.

### Option E: Cosmetic / Report Card Upgrades

**How it works:** Base game is free or cheap. Premium report card features (shareable link, print-quality layout, animated timeline, downloadable PDF) cost extra.

| Dimension | Assessment |
|-----------|------------|
| **Covers costs?** | Only if upgrade rate is high. Report card is the most shareable artifact — gating its shareability hurts virality. |
| **Risk** | The report card IS the emotional payoff. Degrading it for non-payers damages the core experience. |

**Verdict: Never gate the report card itself.** Premium presentation layers (animated web version, physical print, framed art print) could work as upsells *after* the core report card is delivered for free.

### Option F: Season Pass / "Year of Parenting"

**How it works:** Pay $14.99-$19.99 upfront for a bundle of 5 games.

| Dimension | Assessment |
|-----------|------------|
| **Covers costs?** | Yes. $14.99 for 5 games = $3/game vs ~$0.60 typical cost. 80% margin. |
| **Value perception** | Strong. ~40% discount vs $4.99 x 5 = $24.95. Players who know they'll play multiple times get a deal. |
| **Timing** | Too early for launch. Requires proven replay demand. |

**Verdict: Excellent for post-launch.** Introduce after data shows repeat play rates. Don't launch with this — you need single-game pricing to establish the value anchor first.

### Option G: "What If" Replay Premium

**How it works:** After completing a game, pay $2.99 to replay from any event with different choices. Only the divergent events + new endgame cost API tokens.

| Dimension | Assessment |
|-----------|------------|
| **Covers costs?** | Yes. A replay from event 7 costs ~40% of a full game. $2.99 is high-margin. |
| **Fit** | Natural. "What if I'd handled the divorce differently?" is the thought every player has after the report card. |
| **Timing** | Post-v1 feature (explicitly out of scope in PRD). |

**Verdict: Build the architecture for this now (identity snapshots are already per-event). Monetize it post-launch.**

---

## 3. Monetization-Ready Architecture (Build NOW)

These are the specific schema additions, services, and hooks to add to the current implementation plan. Each one is painful to retrofit after launch and trivial to add now.

### 3.1 Per-Game Cost Tracking

Langfuse captures token usage per LLM call, but you need cost data in Postgres to gate access and report margins.

**New table:**

```sql
CREATE TABLE llm_usage (
    id              SERIAL PRIMARY KEY,
    game_id         UUID NOT NULL REFERENCES games(id),
    event_number    INTEGER,
    llm_role        TEXT NOT NULL,           -- 'kid', 'world_manager', 'psychologist', 'report_card'
    model           TEXT NOT NULL,           -- 'claude-haiku-3', 'claude-sonnet-4', etc.
    input_tokens    INTEGER NOT NULL,
    output_tokens   INTEGER NOT NULL,
    cost_cents      INTEGER NOT NULL,        -- cost in hundredths of a cent for precision
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_llm_usage_game ON llm_usage(game_id);
```

**New column on `games`:**

```sql
ALTER TABLE games ADD COLUMN total_cost_cents INTEGER NOT NULL DEFAULT 0;
```

**Implementation:** After every LLM call, record usage in `llm_usage` and increment `games.total_cost_cents`. The Anthropic SDK returns token counts in the response metadata. Wrap this in the `LLMClient` interface — every call flows through one place.

### 3.2 Account Identity (Nullable FK, No Auth Yet)

The PRD explicitly puts auth out of scope for v1. But every game needs to be attributable to an account *later*. Add the FK now, leave it nullable.

**New table:**

```sql
CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE,             -- NULL until auth is added
    display_name    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**New column on `games`:**

```sql
ALTER TABLE games ADD COLUMN created_by_account_id UUID REFERENCES accounts(id);
```

**Implementation:** For v1, `created_by_account_id` is NULL. When auth is added, associate games with accounts. This avoids a painful migration that requires backfilling creator identity from IP logs or guesswork.

### 3.3 Entitlement & Payment Records

Don't build Stripe integration now. Build the internal tables that Stripe will write to.

**New tables:**

```sql
CREATE TABLE entitlements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID REFERENCES accounts(id),
    type            TEXT NOT NULL,           -- 'free_trial', 'single_game', 'bundle_5', 'replay'
    games_remaining INTEGER,                 -- NULL = unlimited (not used now)
    stripe_payment_id TEXT,                  -- NULL until Stripe is wired
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ              -- NULL = never expires
);

CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID REFERENCES accounts(id),
    amount_cents    INTEGER NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'usd',
    stripe_payment_intent_id TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'completed', 'refunded'
    entitlement_id  UUID REFERENCES entitlements(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**New column on `games`:**

```sql
ALTER TABLE games ADD COLUMN entitlement_id UUID REFERENCES entitlements(id);
```

### 3.4 Entitlement Gate (Middleware)

Add a server-side check before game creation. For v1, it always passes. When payments go live, flip it on.

```typescript
// server/src/middleware/entitlement.ts
export async function checkEntitlement(accountId: string | null): Promise<{
  allowed: boolean;
  reason?: string;
  entitlementId?: string;
}> {
  // V1: always allow (no auth, no payments)
  return { allowed: true };

  // Future: check accounts.entitlements for remaining games
}
```

Wire this into the `POST /api/game` route now. The check is a no-op, but the hook is in place.

### 3.5 Model Configuration Externalization

The `LLMClient` interface already supports swapping implementations (NFR-051). Extend this to per-role model selection via configuration, not code changes.

```typescript
// server/src/llm/model-config.ts
export interface ModelConfig {
  kid_family_chat: string;
  kid_sidebar: string;
  kid_adult_chat: string;
  world_manager: string;
  psychologist: string;
  epilogue: string;
  report_card: string;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  kid_family_chat: "claude-haiku-3",
  kid_sidebar: "claude-haiku-3",
  kid_adult_chat: "claude-sonnet-4-20250514",
  world_manager: "claude-sonnet-4-20250514",
  psychologist: "claude-sonnet-4-20250514",
  epilogue: "claude-sonnet-4-20250514",
  report_card: "claude-opus-4-20250514",
};
```

Store as environment variables or a config table. The `ClaudeLLMClient` reads from this config instead of hardcoding the model string.

### 3.6 Report Card as Standalone Shareable Artifact

The report card is the viral vector. It needs its own access path independent of the game session.

**New column on `endgames`:**

```sql
ALTER TABLE endgames ADD COLUMN share_token TEXT UNIQUE;
```

Generate a short, memorable share token (e.g., 8-character alphanumeric) when the report card is created. Serve it at `/report/<share_token>` as a standalone, publicly accessible page. No game session required to view it.

This is the architecture that powers "share your kid's report card on social media" — the single highest-leverage viral mechanic.

### 3.7 Billable vs. Free Route Separation

Tag every route as billable or free in the route definition. This enables the entitlement gate to know which actions consume paid resources.

```typescript
// In route metadata or middleware
const BILLABLE_ROUTES = [
  'POST /api/game',           // Creating a game consumes an entitlement
  'POST /api/game/:id/message', // Each message costs API tokens
  'POST /api/game/:id/next-event',
];

const FREE_ROUTES = [
  'GET /api/game/:id/state',   // Viewing state is free
  'GET /report/:token',        // Viewing shared report cards is free
];
```

### Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    New Tables (add to 001-initial.sql)       │
├─────────────────────────────────────────────────────────────┤
│  accounts          (id, email, display_name)                │
│  entitlements       (id, account_id, type, games_remaining) │
│  payments           (id, account_id, amount, status)        │
│  llm_usage          (id, game_id, role, model, tokens, cost)│
├─────────────────────────────────────────────────────────────┤
│                    New Columns                               │
├─────────────────────────────────────────────────────────────┤
│  games.created_by_account_id  (nullable FK → accounts)      │
│  games.entitlement_id         (nullable FK → entitlements)  │
│  games.total_cost_cents       (running cost tracker)        │
│  endgames.share_token         (public report card URL)      │
├─────────────────────────────────────────────────────────────┤
│                    New Services                              │
├─────────────────────────────────────────────────────────────┤
│  entitlement.ts    (gate check, no-op in v1)                │
│  model-config.ts   (per-role model selection)               │
│  cost-tracker.ts   (records llm_usage after every call)     │
└─────────────────────────────────────────────────────────────┘
```

**Total effort: ~2-3 hours.** All of this is additive (new tables, nullable columns, pass-through middleware). None of it changes existing game logic or blocks the v1 milestone plan.

---

## 4. Pricing Strategy

### Primary Price: $4.99 Per Game

**Justification:**

| Factor | Analysis |
|--------|----------|
| **Cost floor** | $0.35-$1.10 per game (tiered models). $4.99 provides 78-93% gross margin on typical games. |
| **Heavy game safety** | Even a worst-case all-Sonnet heavy game ($2.78) leaves 44% gross margin at $4.99. |
| **Indie game comps** | Mobile indie games: $2.99-$6.99. Premium narrative games (Florence, Device 6, 80 Days): $4.99. This game delivers a 60-90 minute unique experience with a partner — $4.99 is well within the expected range. |
| **Per-hour value** | $4.99 / 75 minutes = $3.99/hour. A movie ticket is ~$8-12/hour. A board game cafe is ~$5-8/hour. Competitive. |
| **Psychological pricing** | $4.99 is below the $5 threshold. It's an impulse purchase for most target demographics. |

### Who Pays: The Host

The player who creates the game pays. The player who receives the invite link plays free. This is non-negotiable for the viral mechanics:

- If both players must pay, the invitation friction doubles and the "send this to a friend" loop breaks.
- If payment happens mid-game, you shatter immersion during the most emotionally engaged moment.
- "I'll pay, you just click this link" is a natural, generous social gesture that fits the game's emotional tone.

### Free First Game (Truncated)

The first game is free but truncated to ~5 events (roughly ages 3-10). No epilogue, no adult conversations, and a simplified report card. Cost to serve: ~$0.15-$0.30 with Haiku.

**Why truncated, not full:** A full free game costs $0.35-$1.10. At scale (10K free games), that's $3,500-$11,000 in API costs before a single dollar of revenue. Truncation at event 5 is the natural midpoint — the child is ~10 years old, the identity is forming, and the player is emotionally invested. The pull of "what happens in the teenage years?" is the conversion trigger.

**Why not zero free games:** Two-player games require trust. Players need to experience the game before paying $4.99 for something they can't return. The truncated free game is the demo.

### Future Price Points

| Product | Price | When to Introduce |
|---------|-------|-------------------|
| Single game | $4.99 | Launch |
| 5-game bundle | $14.99 (40% off) | After proving repeat play demand (~3 months post-launch) |
| "What If" replay | $2.99 | When replay feature ships (post-v1) |
| Premium report card (animated web page, printable PDF, physical print) | $1.99 / $4.99 / $19.99 | When share feature ships |

---

## 5. Growth & Viral Mechanics

### The Report Card Is the Viral Engine

The report card is the single most shareable artifact in the game. It is personalized, emotional, and conversation-starting. The entire viral strategy hinges on making report cards easy to share and compelling to view.

**Mechanics:**

1. **Standalone shareable URL.** Every report card gets a public URL (`raisingintelligences.com/report/a7f3k9m2`). No login required to view. The page is beautifully designed — the "most designed screen" in the game.

2. **Social sharing hooks.** The report card page includes Open Graph meta tags with a preview that shows the child's name and 1-2 key traits. When shared on social media, the preview is intriguing enough to click. Example preview text: *"We raised Luna. She became someone who laughs at things that scare her."*

3. **Call to action on shared report cards.** The public report card page includes a single, non-pushy CTA: *"Raise your own. Play with a friend."* Links to the game creation flow.

4. **The share prompt is after the emotional peak.** Players see the report card *after* the epilogue and adult conversations — the most emotionally intense part of the game. The share prompt arrives when they're most likely to act on it. Don't bury the share button. Don't add extra steps. One tap: share.

### Co-Play Invitations as Viral Loops

Every game requires two players. Every game creates a new potential evangelist. The invitation is the growth loop:

```
Player A plays with Player B
→ Player B is hooked
→ Player B creates a game and invites Player C (new player)
→ Player C plays, shares report card
→ Player D sees report card, creates a game, invites Player E
```

**Key insight:** The guest plays free. The guest becomes a future host. This is the "first hit is free" dynamic, but with genuine generosity — the guest gets a full, emotional experience at no cost.

**Mechanics to amplify this:**

- After the report card, prompt: *"Play again with someone new?"* Pre-fill a creation flow.
- Let players add a personal message to the invitation link: *"You have to try this with me. I just raised an AI kid who became a jazz musician."*
- Track invitation chains. If Player B (invited by A) later creates a game, Player A could get a notification: *"Your friend raised a kid named [name]. Want to see how they turned out?"* (Only if Player B opts in.)

### The "Kids You've Raised" Gallery

Once accounts exist, the gallery becomes a retention and viral surface:

- Players see a grid of all the kids they've raised (child name, age photo placeholder, 1-line personality summary from report card).
- Each entry links to the full report card.
- The gallery is itself shareable: *"I've raised 7 AI kids. Here's who they became."*
- Social proof for new players: *"4,000 kids raised this month."*

### How Monetization Amplifies (Not Kills) Virality

- **Report card viewing is always free.** Never gate the viral artifact behind a paywall.
- **The free truncated game is itself a viral unit.** Two players share a free experience, both may convert.
- **The host-pays model makes invitations generous.** "I already paid, just click the link" is a gift, not a sales pitch.
- **Bundles reward repeat hosts.** Players who regularly invite new people get a volume discount, incentivizing more invitations.

---

## 6. Anti-Patterns to Avoid

### Never Paywall the Emotional Payoff

The cardinal sin: letting a player invest 60-90 minutes of emotional energy and then demanding payment before they see the epilogue or report card. This destroys trust, generates rage, and creates negative word-of-mouth that no amount of marketing can overcome.

**Rule:** Once a game has started, the player will see the ending. Period. Payment happens *before* the game begins, never during or after.

The free truncated game is an exception that proves the rule — players know upfront that the free game covers ages 3-10. The boundary is set before they start, not sprung on them mid-experience.

### Never Gate Report Card Sharing

The report card is the viral engine. Making it "premium" to share is optimizing for short-term revenue at the cost of long-term growth. Premium *presentation* upgrades (animated timeline, print layout) are fine. Preventing a player from showing their friend what they created is not.

### Never Add Ads

Ads in a black-and-white typography-driven emotional experience are absurd. This is a game about raising a child with someone you care about. A banner ad for credit cards at the bottom of the epilogue would be aesthetic suicide. Beyond aesthetics, the CPMs achievable on a niche art game would generate negligible revenue relative to the damage.

### Never Sell Gameplay Advantages

There is nothing to "boost" in this game. If you could pay to make the kid smarter, more obedient, or more successful, you would destroy the game's thesis — that outcomes emerge from how you parent, not from what you spend. No XP boosters, no "premium personality traits," no "unlock the gifted child."

### Never Add Loot Boxes or Gacha Mechanics

The game has no randomized rewards, no collectibles, no inventory. These mechanics have no natural home here and would signal that the developers have no idea what their game is.

### Never Break Immersion With Monetization UI

Payment and monetization should exist entirely outside the game loop. The lobby (before the game starts) and the report card screen (after the game ends) are the only acceptable locations for monetization surfaces. During gameplay, there should be zero indication that money exists.

### Avoid Subscription Until Proven Wrong

Subscription models create expectations of continuous content delivery. This game delivers discrete, complete experiences. A subscription signals "we'll keep making new stuff" when what you're really selling is "play the same game with different people." Wait until you have content like seasonal scenarios, themed event packs, or cooperative challenges before considering subscription — and only if the marginal cost math has changed.

---

## 7. Recommended Strategy

### The Model: Freemium With Pay-Per-Game

**Phase 1 (Launch):**
- First game free (truncated to ~5 events, ~ages 3-10, simplified report card)
- Full games: $4.99 each
- Host pays, guest plays free
- Report card sharing is always free
- Model tiering (Haiku for Kid/family chat, Sonnet for everything else, Opus for report card)
- Per-game cost tracking from day one

**Phase 2 (Month 2-3, after launch data):**
- Introduce accounts (email-based, lightweight)
- "Kids You've Raised" gallery for returning players
- 5-game bundle for $14.99

**Phase 3 (Month 4-6):**
- Shareable report card public pages with social preview
- Premium report card upgrades (animated web version: $1.99, print-quality PDF: $4.99)
- Stripe integration for payments

**Phase 4 (Post-v1, when replay feature ships):**
- "What If" replays: $2.99 each
- Physical report card prints: $19.99 (partner with a print-on-demand service)

### Implementation Priority (What to Build in What Order)

| Priority | Item | Effort | Why Now |
|----------|------|--------|---------|
| **P0** | `llm_usage` table + cost tracking in `LLMClient` wrapper | 2 hours | You cannot price without data. Start capturing costs from your first playtest. |
| **P0** | Model config externalization (`model-config.ts`) | 1 hour | Reduces costs 60% immediately. Changes one config object, not code. |
| **P0** | `accounts` table + nullable FK on `games` | 30 min | Painless now. Painful migration later. |
| **P1** | `endgames.share_token` + public report card route | 2 hours | The viral engine. Build it before you need it. |
| **P1** | Entitlement gate (no-op middleware) | 1 hour | The hook for payment. No-op in v1, flip-on later. |
| **P2** | `entitlements` + `payments` tables | 30 min | Schema only. No Stripe integration yet. |
| **P2** | Free game truncation logic (stop at event 5, skip to simplified report card) | 2 hours | Required for the freemium model. Can be a config flag. |
| **P3** | Stripe integration | 4-6 hours | Only needed when you're ready to charge. |

### The Bet

This strategy bets that:

1. **The game is good enough that 5 free events create conversion pressure.** If players finish the truncated game and shrug, the pricing model doesn't matter — the game needs work.

2. **Emotional investment converts to payment.** "I need to know what my kid becomes as a teenager" is a stronger conversion trigger than any marketing copy.

3. **Report card sharing drives organic growth.** If report cards are compelling enough to share, acquisition cost is near-zero. If they're not, you need to iterate on the report card, not the marketing.

4. **Two-player co-play creates natural invitation loops.** Every game requires a second player, and every guest is a future host.

If any of these assumptions prove wrong, the architecture supports pivoting: drop prices, extend the free game, try PWYW as a supplement, or add seasonal content. The cost tracking and entitlement infrastructure let you experiment without rebuilding.

### What Success Looks Like

| Metric | 3-Month Target | 6-Month Target |
|--------|---------------|----------------|
| Games played (total) | 1,000 | 10,000 |
| Free-to-paid conversion rate | 15-25% | 20-30% |
| Average revenue per paying user | $4.99 | $6-8 (mix of singles + bundles) |
| Monthly revenue | $750-$1,250 | $4,000-$8,000 |
| Report card share rate | 30% | 40%+ |
| Organic (non-paid) acquisition | 80%+ | 70%+ |
| LLM cost as % of revenue | 15-25% | 10-20% (model improvements + caching) |

These numbers assume indie-scale growth: word of mouth, social sharing, a few press mentions. Not venture-scale. This is a sustainable art game, not a growth-at-all-costs startup.

---

## Appendix: Per-Game Economics at $4.99

```
Revenue:                          $4.99
├── Payment processing (Stripe):  -$0.45  (2.9% + $0.30)
├── LLM cost (typical, tiered):   -$0.60
├── Infrastructure (amortized):   -$0.05
└── Gross profit:                  $3.89  (78% margin)

At 1,000 games/month:
├── Revenue:       $4,990
├── Stripe fees:   -$450
├── LLM costs:     -$600
├── Infrastructure: -$45
└── Net:           $3,895/month
```

At scale, the biggest lever for margin improvement is LLM cost reduction through prompt optimization, response caching (for World Manager event templates), and next-generation model pricing. Anthropic's pricing trends downward over time — every price cut is a margin expansion.
