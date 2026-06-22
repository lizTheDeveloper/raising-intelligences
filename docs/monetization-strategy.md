# Raising Intelligences — Monetization Strategy

*Revised 2026-06-22. OpenRouter + open-source model pricing. Credits-based monetization.*

---

## 1. Cost Structure Analysis (OpenRouter)

### LLM Call Volume Per Game (unchanged)

| Role | Calls Per Event | Events | Subtotal (Light/Typical/Heavy) |
|------|-----------------|--------|-------------------------------|
| **Kid — Family Chat** | 4-12 | 10-12 | 40 / 88 / 144 |
| **Kid — Sidebars** | 0-12 | 10-12 | 0 / 24 / 96 |
| **Kid — Adult Conversations** | 4-12 per convo | 2-3 | 8 / 18 / 36 |
| **World Manager** | 1 per event + epilogue + scenarios | — | 13 / 14 / 16 |
| **Psychologist** | 1 per event | 10-12 | 10 / 11 / 12 |
| **Report Card** | 1 | — | 1 / 1 / 1 |
| **Total** | | | **72 / 156 / 305** |

### OpenRouter Model Tiering Strategy

The key insight: the Kid role accounts for 70-90% of all LLM calls but only needs short, conversational responses. Use the cheapest viable model there and spend the savings on quality where it matters.

**Recommended Model Assignments:**

| Role | Model | Why | Input $/MTok | Output $/MTok |
|------|-------|-----|-------------|--------------|
| Kid (family chat, sidebars) | **DeepSeek V4 Flash** | Highest call volume, short outputs, streaming. Absurdly cheap. Good enough for age-appropriate dialogue. | $0.09 | $0.18 |
| Kid (adult conversations) | **Qwen 3.7 Plus** | Fewer calls, needs more nuance. Still cheap. | $0.32 | $1.28 |
| World Manager (events) | **Qwen 3.7 Plus** | Needs narrative creativity, parenting-dynamic awareness. Low call count. | $0.32 | $1.28 |
| Psychologist | **Qwen 3.7 Max** | Most critical prompt — personality formation. Worth spending here. | $1.25 | $3.75 |
| Epilogue | **Qwen 3.7 Max** | 1 call, needs to be a compelling story. | $1.25 | $3.75 |
| Report Card | **Qwen 3.7 Max** | The artifact players keep and share. Quality matters. | $1.25 | $3.75 |

**Upgrade tier (for premium credits):**

| Role | Model | Input $/MTok | Output $/MTok |
|------|-------|-------------|--------------|
| Kid (all) | **Qwen 3.7 Plus** | $0.32 | $1.28 |
| World Manager | **Qwen 3.7 Max** | $1.25 | $3.75 |
| Psychologist | **Gemini 3.5 Flash** | $1.50 | $9.00 |
| Epilogue | **Claude Opus 4.7** | $5.00 | $25.00 |
| Report Card | **Claude Opus 4.7** | $5.00 | $25.00 |

### Per-Game Cost Breakdown (Standard Tier)

#### Kid — Family Chat + Sidebars (DeepSeek V4 Flash)

| Metric | Light | Typical | Heavy |
|--------|-------|---------|-------|
| Calls | 40 | 112 | 240 |
| Input tokens (context grows per event) | ~100K | ~201K | ~400K |
| Output tokens (~200 avg) | ~8K | ~22K | ~48K |
| Input cost | $0.009 | $0.018 | $0.036 |
| Output cost | $0.001 | $0.004 | $0.009 |
| **Subtotal** | **$0.010** | **$0.022** | **$0.045** |

#### Kid — Adult Conversations (Qwen 3.7 Plus)

| Metric | Light | Typical | Heavy |
|--------|-------|---------|-------|
| Calls | 8 | 18 | 36 |
| Input tokens | ~24K | ~68K | ~162K |
| Output tokens | ~2K | ~5K | ~14K |
| Input cost | $0.008 | $0.022 | $0.052 |
| Output cost | $0.003 | $0.006 | $0.018 |
| **Subtotal** | **$0.011** | **$0.028** | **$0.070** |

#### World Manager (Qwen 3.7 Plus)

| Metric | Light | Typical | Heavy |
|--------|-------|---------|-------|
| Calls | 13 | 14 | 16 |
| Input tokens | ~20K | ~31K | ~48K |
| Output tokens | ~3K | ~3K | ~5K |
| Input cost | $0.006 | $0.010 | $0.015 |
| Output cost | $0.004 | $0.004 | $0.006 |
| **Subtotal** | **$0.010** | **$0.014** | **$0.021** |

#### Psychologist (Qwen 3.7 Max)

| Metric | Light | Typical | Heavy |
|--------|-------|---------|-------|
| Calls | 10 | 11 | 12 |
| Input tokens | ~20K | ~33K | ~48K |
| Output tokens | ~3K | ~4K | ~6K |
| Input cost | $0.025 | $0.041 | $0.060 |
| Output cost | $0.011 | $0.015 | $0.023 |
| **Subtotal** | **$0.036** | **$0.056** | **$0.083** |

#### Epilogue + Report Card (Qwen 3.7 Max)

| Metric | Light | Typical | Heavy |
|--------|-------|---------|-------|
| Input tokens | ~14K | ~18K | ~24K |
| Output tokens | ~2K | ~3K | ~4K |
| Input cost | $0.018 | $0.023 | $0.030 |
| Output cost | $0.008 | $0.011 | $0.015 |
| **Subtotal** | **$0.026** | **$0.034** | **$0.045** |

### Per-Game Cost Summary

| Profile | Standard Tier | Premium Tier (Claude report card) |
|---------|--------------|-----------------------------------|
| **Light** | **$0.09** | **$0.19** |
| **Typical** | **$0.15** | **$0.35** |
| **Heavy** | **$0.26** | **$0.55** |

**Compared to the original all-Claude analysis:**

| Profile | Direct Claude (Sonnet) | Claude + Haiku Tiering | OpenRouter Standard | Savings vs Original |
|---------|----------------------|----------------------|--------------------|--------------------|
| Light | $0.93 | $0.35 | **$0.09** | **90%** |
| Typical | $1.59 | $0.60 | **$0.15** | **91%** |
| Heavy | $2.78 | $1.10 | **$0.26** | **91%** |

At $0.09-$0.26 per game, **you can afford to give away a lot of free games.**

### Infrastructure Costs

| Item | Estimated Monthly Cost |
|------|----------------------|
| Hosting (Fly.io/Railway) | $5-20 |
| Postgres (Neon free tier → $25) | $0-25 |
| Domain | ~$1/month |
| **Total infra** | **$6-46/month** |

---

## 2. Revenue Model: Credits System

### Why Credits, Not Per-Game Purchase

Per-game purchase ($4.99) has two problems:
1. **Too much friction for an unknown game.** Nobody pays $5 for something they've never tried.
2. **Overpriced for the cost.** At $0.15/game, a $4.99 price feels exploitative once players learn the economics.

Credits solve both:
- **Low entry price.** $1.99 gets you started. That's impulse-buy territory.
- **Generous free tier.** You can afford 3 free games at $0.45 total acquisition cost.
- **Repeat purchase.** Players buy more credits as they want to play with different people.
- **Flexible pricing.** Bundle discounts reward commitment without locking people in.

### Credit Tiers

| Package | Price | Credits | Per-Credit | Per-Game Cost | Margin |
|---------|-------|---------|-----------|---------------|--------|
| **Free** | $0 | 3 | — | $0.15 | -$0.45 total (acquisition) |
| **Starter** | $1.99 | 5 | $0.40 | $0.15 | 63% |
| **Standard** | $3.99 | 12 | $0.33 | $0.15 | 55% |
| **Best Value** | $6.99 | 25 | $0.28 | $0.15 | 46% |

1 credit = 1 full game (10-12 events, epilogue, adult conversations, report card).

### How Credits Work

- **Creating a game costs 1 credit.** The host spends the credit.
- **Joining a game is always free.** Guest clicks the link, plays immediately, no account needed to join.
- **Guests are prompted to create an account after the report card.** "Want to raise your own? Sign up for 3 free games."
- **Credits never expire.** Buy them whenever, use them whenever.

### Premium Credits (Future, Post-Launch)

Once the standard tier is validated, introduce premium credits that unlock higher-quality AI:

| Package | Price | Credits | What's Different |
|---------|-------|---------|-----------------|
| **Premium 5** | $3.99 | 5 | Claude Opus for report card + epilogue. Richer, more specific narrative. |
| **Premium 12** | $7.99 | 12 | Same |

Premium games cost ~$0.35/game (vs $0.15 standard), so margins are still 47-56%.

The pitch: *"Premium games use a more powerful AI. The report card goes deeper — more specific memories, sharper observations, quotes you actually said."*

### Free Games Are the Funnel

At $0.15/game, the math on free games is generous:

| Free Games Given | Total Acquisition Cost | Break-Even (1 Starter Purchase) |
|-----------------|----------------------|-------------------------------|
| 3 (default) | $0.45 | 1 in 4 players converts (25%) |
| 5 (promotional) | $0.75 | 1 in 3 players converts (33%) |

**Earning free credits:**
- Sign up: **3 free credits**
- Invite a friend who signs up: **1 free credit** (both players get one)
- Share a report card that gets 10+ views: **1 free credit**

This turns every player into a growth engine. The referral credit costs $0.15 — an absurdly cheap acquisition channel.

---

## 3. Monetization-Ready Architecture (Build NOW)

### 3.1 OpenRouter Client (replaces direct Anthropic SDK)

```typescript
// server/src/llm/openrouter.ts
interface ModelConfig {
  kid_family_chat: string;
  kid_sidebar: string;
  kid_adult_chat: string;
  world_manager: string;
  psychologist: string;
  epilogue: string;
  report_card: string;
}

const STANDARD_MODELS: ModelConfig = {
  kid_family_chat: "deepseek/deepseek-v4-flash",
  kid_sidebar: "deepseek/deepseek-v4-flash",
  kid_adult_chat: "qwen/qwen3.7-plus",
  world_manager: "qwen/qwen3.7-plus",
  psychologist: "qwen/qwen3.7-max",
  epilogue: "qwen/qwen3.7-max",
  report_card: "qwen/qwen3.7-max",
};

const PREMIUM_MODELS: ModelConfig = {
  kid_family_chat: "qwen/qwen3.7-plus",
  kid_sidebar: "qwen/qwen3.7-plus",
  kid_adult_chat: "qwen/qwen3.7-max",
  world_manager: "qwen/qwen3.7-max",
  psychologist: "google/gemini-3.5-flash",
  epilogue: "anthropic/claude-opus-4.7",
  report_card: "anthropic/claude-opus-4.7",
};
```

OpenRouter uses the OpenAI-compatible API format, so the `LLMClient` interface stays the same — only the implementation changes. The `@anthropic-ai/sdk` dependency becomes `openai` (OpenRouter is OpenAI-compatible).

### 3.2 Per-Game Cost Tracking

```sql
CREATE TABLE llm_usage (
    id              SERIAL PRIMARY KEY,
    game_id         UUID NOT NULL REFERENCES games(id),
    event_number    INTEGER,
    llm_role        TEXT NOT NULL,
    model           TEXT NOT NULL,
    input_tokens    INTEGER NOT NULL,
    output_tokens   INTEGER NOT NULL,
    cost_cents      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE games ADD COLUMN total_cost_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN model_tier TEXT NOT NULL DEFAULT 'standard';
```

OpenRouter returns token counts and cost in response headers (`x-ratelimit-*`) and response body. Log every call.

### 3.3 Accounts & Credits

```sql
CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    display_name    TEXT,
    credits         INTEGER NOT NULL DEFAULT 3,
    referral_code   TEXT UNIQUE NOT NULL,
    referred_by     UUID REFERENCES accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES accounts(id),
    amount          INTEGER NOT NULL,          -- positive = earned/purchased, negative = spent
    reason          TEXT NOT NULL,             -- 'signup_bonus', 'purchase', 'referral', 'game_created', 'share_bonus'
    game_id         UUID REFERENCES games(id), -- which game consumed this credit
    stripe_payment_id TEXT,                    -- NULL for non-purchase transactions
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE games ADD COLUMN created_by UUID REFERENCES accounts(id);
ALTER TABLE games ADD COLUMN credit_transaction_id UUID REFERENCES credit_transactions(id);
```

### 3.4 Report Card Sharing (Viral Engine)

```sql
ALTER TABLE endgames ADD COLUMN share_token TEXT UNIQUE;
ALTER TABLE endgames ADD COLUMN share_views INTEGER NOT NULL DEFAULT 0;
```

Public route: `GET /report/:share_token` — no auth required.

OG meta tags for social preview:
```html
<meta property="og:title" content="We raised Luna" />
<meta property="og:description" content="She became someone who laughs at things that scare her." />
<meta property="og:image" content="/api/report/:token/og-image" />
```

The OG image is generated server-side: a clean typographic card with the child's name and 1-2 key traits.

### 3.5 Credit Gate Middleware

```typescript
// server/src/middleware/credits.ts
export async function requireCredit(accountId: string): Promise<{
  allowed: boolean;
  creditsRemaining: number;
  reason?: string;
}> {
  const account = await db.getAccount(accountId);
  if (!account) return { allowed: false, creditsRemaining: 0, reason: "Account not found" };
  if (account.credits <= 0) return { allowed: false, creditsRemaining: 0, reason: "No credits remaining" };
  return { allowed: true, creditsRemaining: account.credits };
}

export async function spendCredit(accountId: string, gameId: string): Promise<void> {
  // Atomic: decrement credits + insert transaction in one query
  await db.query(`
    WITH deducted AS (
      UPDATE accounts SET credits = credits - 1 WHERE id = $1 AND credits > 0 RETURNING id
    )
    INSERT INTO credit_transactions (account_id, amount, reason, game_id)
    SELECT $1, -1, 'game_created', $2 FROM deducted
  `, [accountId, gameId]);
}
```

### 3.6 Guest-to-Account Conversion Flow

After the report card, guests (players who joined via link without an account) see:

```
"Want to raise your own?"
[Sign up — get 3 free games]
```

If the host had a referral code in the game link, both players get a bonus credit on signup.

### Architecture Summary

```
┌──────────────────────────────────────────────────────────────┐
│  New Tables                                                   │
├──────────────────────────────────────────────────────────────┤
│  accounts            (id, email, credits, referral_code)      │
│  credit_transactions (id, account_id, amount, reason, game_id)│
│  llm_usage           (id, game_id, role, model, tokens, cost) │
├──────────────────────────────────────────────────────────────┤
│  Modified Tables                                              │
├──────────────────────────────────────────────────────────────┤
│  games.created_by         (FK → accounts)                     │
│  games.total_cost_cents   (running cost tracker)              │
│  games.model_tier         ('standard' | 'premium')            │
│  games.credit_txn_id      (FK → credit_transactions)          │
│  endgames.share_token     (public report card URL)            │
│  endgames.share_views     (viral tracking)                    │
├──────────────────────────────────────────────────────────────┤
│  New Services                                                 │
├──────────────────────────────────────────────────────────────┤
│  openrouter.ts       (OpenRouter LLM client, OpenAI-compat)  │
│  model-config.ts     (per-role model selection, std/premium)  │
│  credits.ts          (credit gate, spend, earn middleware)    │
│  cost-tracker.ts     (logs llm_usage after every call)        │
│  referral.ts         (referral code gen, credit award)        │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Pricing & Positioning

### Price Anchoring

The game is positioned as **cheaper than a coffee, more memorable than a movie.**

| Comparison | Price | Duration | $/hour |
|-----------|-------|----------|--------|
| Raising Intelligences (1 credit) | $0.40 | ~75 min | $0.32 |
| Mobile game (premium) | $4.99-6.99 | varies | varies |
| Movie ticket | $12-16 | 120 min | $6-8 |
| Board game cafe | $10-15 | 120 min | $5-8 |
| Escape room (per person) | $30-40 | 60 min | $30-40 |

At $0.28-$0.40 per game (credit pricing), this is an impulse-level commitment.

### Why This Works Better Than $4.99/Game

| Factor | $4.99/game | Credits ($1.99-$6.99) |
|--------|-----------|----------------------|
| First purchase barrier | High — $5 for unknown game | Low — $1.99 to try |
| Free games possible | 1 (expensive at $0.60+ cost) | 3 (cheap at $0.45 cost) |
| Repeat purchase | Same $5 every time | Bulk discounts reward loyalty |
| Social pressure | "Pay $5 to play with me" | "I already have credits, just click the link" |
| Perceived value | Fixed, may feel expensive | Flexible, volume discounts feel generous |

---

## 5. Growth & Viral Mechanics

### The Flywheel

```
Sign up (3 free credits)
  → Play with a friend (guest joins free)
    → Both see report card
      → Guest signs up (3 free credits + 1 referral bonus each)
        → Guest plays with a NEW friend
          → Repeat
```

**Every game spawns two potential new hosts.** At $0.15/game, you can fuel this flywheel aggressively.

### Credit-Earning Mechanics

| Action | Credits Earned | Cost to You | Why It's Worth It |
|--------|---------------|-------------|-------------------|
| Sign up | 3 | $0.45 | Core acquisition |
| Referral (friend signs up) | 1 (both get it) | $0.30 total | Cheapest acquisition channel possible |
| Report card gets 10+ views | 1 | $0.15 | Rewards organic sharing |
| Seasonal promotion | 1-2 | $0.15-$0.30 | Reactivation |

### Report Card Sharing

The report card page is public, beautiful, and has one CTA:

*"We raised [name]. Raise your own — play with a friend."*

The OG preview shows: child's name + 1-2 key traits. Designed to be conversation-starting on social media.

---

## 6. Anti-Patterns to Avoid

1. **Never paywall the report card or epilogue.** Once a game starts, the player sees the ending. Credits are spent at game creation, not mid-game.

2. **Never make guests pay.** The frictionless invite link is the entire viral mechanic. Adding a paywall to joining kills it.

3. **No ads.** Aesthetic suicide in a typography-driven art game.

4. **No "energy" or "stamina" timers.** Credits are purchased, not refilled over time. This isn't a mobile gacha game.

5. **No gameplay advantages for purchase.** You can't buy a smarter kid or easier events.

6. **Don't show monetization UI during gameplay.** Credits are managed in the lobby and account screens. During a game session: zero payment surfaces.

7. **Don't over-differentiate standard vs premium.** Standard games must be great. Premium is "extra polish," not "the real game."

---

## 7. Recommended Rollout

### Phase 1: Soft Launch (no payments)

- Free for everyone, no credit system yet
- Add `llm_usage` tracking and `model-config.ts` from day one
- Use standard tier models (DeepSeek + Qwen)
- Add `share_token` to report cards
- Collect cost data, validate model quality, playtest
- **Goal:** Prove the game is fun. Get 50-100 games played.

### Phase 2: Accounts + Credits (month 1-2)

- Add account system (email + magic link, no password)
- 3 free credits on signup
- Credit purchase via Stripe ($1.99 / $3.99 / $6.99)
- Referral system (unique codes, bonus credits)
- Guest-to-account conversion after report card
- **Goal:** Prove conversion. Target 20-30% free-to-paid.

### Phase 3: Viral Features (month 2-3)

- Public report card pages with OG previews
- "Kids You've Raised" gallery
- Share-for-credits mechanic
- **Goal:** Organic growth exceeds paid acquisition.

### Phase 4: Premium Tier (month 3-4)

- Premium credits with Claude-powered report cards
- Premium indicator on report cards ("powered by Claude Opus")
- A/B test premium vs standard quality perception
- **Goal:** 15-20% of purchases are premium.

### What Success Looks Like

| Metric | 3-Month Target | 6-Month Target |
|--------|---------------|----------------|
| Games played (total) | 1,500 | 15,000 |
| Registered accounts | 1,000 | 8,000 |
| Free-to-paid conversion | 20-30% | 25-35% |
| Average revenue per paying user | $3.50 | $5-7 (repeat purchases) |
| Monthly revenue | $700-$1,000 | $4,000-$8,000 |
| LLM cost as % of revenue | 8-12% | 6-10% |
| Report card share rate | 30% | 45%+ |
| Organic acquisition | 80%+ | 75%+ |

---

## Appendix A: Per-Game Economics at Credit Pricing

```
Revenue per credit (avg across packs):     $0.33
├── Payment processing (Stripe 2.9%+30¢):  ~$0.04 (amortized across pack)
├── LLM cost (typical, standard tier):      -$0.15
├── Infrastructure (amortized):             -$0.01
└── Gross profit per game:                   $0.13  (39% margin on avg credit)

At best-value pricing ($6.99/25):           $0.28/credit
├── LLM cost:                               -$0.15
├── Stripe (amortized):                     -$0.02
└── Gross profit:                            $0.11  (39% margin)

At starter pricing ($1.99/5):               $0.40/credit
├── LLM cost:                               -$0.15
├── Stripe (amortized):                     -$0.08
└── Gross profit:                            $0.17  (43% margin)
```

### Break-Even Analysis

| Scenario | Monthly Games | LLM Cost | Revenue Needed | Credits Sold |
|----------|-------------|----------|---------------|-------------|
| Cover infra only | any | — | $25/month | ~75 credits |
| Cover infra + LLM | 500 | $75 | $100/month | ~300 credits |
| Sustainable indie | 2,000 | $300 | $2,000/month | ~6,000 credits |
| Comfortable | 5,000 | $750 | $5,000/month | ~15,000 credits |

## Appendix B: Model Quality Validation Plan

Before committing to the model tiering, run a quality gauntlet:

1. **Play 5 full games** with DeepSeek V4 Flash as the Kid. Note where it breaks character, gives age-inappropriate responses, or feels robotic.
2. **Play 3 games** with Qwen 3.7 Plus as the Kid for comparison.
3. **Generate 10 report cards** with Qwen 3.7 Max. Compare 3 with Claude Opus. Is the quality difference noticeable?
4. **Test the Psychologist** with both Qwen 3.7 Max and Gemini 3.5 Flash. Does the identity document evolve convincingly?

If DeepSeek V4 Flash doesn't hold up for the Kid role, fall back to Qwen 3.6 Flash ($0.19/$1.13 per MTok) — still 5-10x cheaper than Sonnet. The cost difference between these two for the Kid role is ~$0.01-$0.04/game, so quality wins.

## Appendix C: OpenRouter Integration Notes

- **API format:** OpenAI-compatible. Use the `openai` npm package pointed at `https://openrouter.ai/api/v1`.
- **Auth:** Single API key via `OPENROUTER_API_KEY` env var.
- **Streaming:** Supported via SSE, same as OpenAI.
- **Cost tracking:** Response includes `usage.prompt_tokens` and `usage.completion_tokens`. OpenRouter also returns cost in the response body under `usage.cost` (in USD).
- **Fallback routing:** OpenRouter supports fallback models via the `route` parameter. If DeepSeek is down, fall back to Qwen automatically.
- **Rate limits:** Vary by model and account tier. Monitor via response headers.

```typescript
import OpenAI from "openai";

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://raisingintelligences.com",
    "X-Title": "Raising Intelligences",
  },
});
```
