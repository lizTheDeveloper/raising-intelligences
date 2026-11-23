# Raising Intelligences

An AI-powered narrative game where you raise a child from birth to adulthood.

You're raising a person who will outlive you. Every response you give shapes who they become — not just what they do, but how they understand themselves. Somewhere around age 10, they'll start lying. At 14, the lies will become secrets. At 17, they'll ask you something that doesn't have a clean answer. You'll wish you had time to prepare.

You won't.

[Play now](https://multiversegames.ai/raising-intelligences/)

---

## How it works

You play through 10–12 life events spanning ages 0 to 25. Each event starts with a scene the child is in — a tantrum at 3, a school problem at 9, a broken curfew at 16. You talk to them in real time. A separate AI (the "Psychologist") maintains an **Identity Document** — a living psychological portrait that tracks what they believe about themselves, what memories stuck, how their inner voice works.

The Identity Document evolves across the entire game. Early entries sound like they were written about a toddler. Later ones read differently. By the end, it's not a summary of what you chose. It's an artifact of who they became because of what you chose.

At the end, you get two things:
- An **epilogue** — a narrative about their life at 25
- A **report card** — a keepsake you can share

### Modes

**Solo** — raise a child on your own.

**Multiplayer (2 players)** — co-parent with a friend, partner, sibling, ex. You both see the same events and chat together. You can also use the **sidebar**: pull the kid aside for a private 1-on-1 conversation that the other player doesn't see. What you say in the sidebar might not match what your co-parent said. That's the point.

---

## Setup

You need Node.js 20+.

```bash
npm install
npm run dev
```

This starts the server on `:3000` and the Vite dev server on `:5173` simultaneously. Open [http://localhost:5173/raising-intelligences/](http://localhost:5173/raising-intelligences/).

No database required — the server runs fully in-memory by default.

### With Postgres

The repo ships a Postgres compose file in `/db`:

```bash
cd db && docker compose up -d
cd ..
npm run migrate -w server
```

Then set `DATABASE_URL` in your `.env` (see `.env.example`).

### Environment variables

Copy `.env.example` to `.env`. The required keys:

- `OPENROUTER_API_KEY` — for LLM calls and portrait generation
- `OPENAI_API_KEY` — optional, only if you want direct OpenAI image generation (portraits use OpenRouter by default)
- `LANGFUSE_*` — optional, enables LLM call tracing
- `ADMIN_TOKEN` — optional, enables the admin dashboard at `/raising-intelligences/admin` (requires `DATABASE_URL`); also authenticates `DELETE /api/admin/games/:id`, which erases a game on a player's request
- `CAMPUS_PASS_PUBLIC_KEY` — optional; overrides the pinned campus launch-pass public key (see "Campus cabinet")
- `RI_RESEARCH_ENABLED` — optional, default off; only the exact value `true` enables the research features. Leave off until the copy and the consent and age handling are reviewed
- `RI_PARTNER_PAYWALL` — optional, default off; `on` charges the host $20 once per child raised with a second human, at the moment the partner has joined (both parents' answers in), before anything is generated for the child. Needs `RI_STRIPE_SECRET_KEY` (test mode) and `RI_STRIPE_WEBHOOK_SECRET`; a live key is refused unless `RI_STRIPE_LIVE_PAYMENTS=true`. See "Partner play payment" below

The server works without any of these, but LLM calls will fail without an API key.

---

## Partner play payment

Solo play is free. Raising a child with a second human costs the host **$20 per child, once** (`server/src/payments/`, spec: `docs/superpowers/specs/2026-07-31-coparent-matchmaking-design.md`, "Pricing and who pays").

- **Host** = the `parent1` seat (the creator of an invite game; in stranger mode, whoever queued first).
- **When**: the child becomes `due` once both seats are held by people and both parents' answers are in. No seed or scene is generated until it is `paid`. An invite nobody opens, or a partner who leaves before the quiz, is never charged.
- **Once**: repeated clicks reuse the open Checkout Session, a second paid session for the same child is refunded automatically, webhook events are processed once, and the due → paid write is a single conditional UPDATE.
- **Routes**: `POST /api/partner-payment/checkout` (host token), `POST /api/partner-payment/confirm` (after the Stripe redirect), `POST /api/stripe/webhook` (signed), `POST /api/admin/games/:id/refund` (admin token).
- **Off by default.** With `RI_PARTNER_PAYWALL` unset, partner play is exactly the old free flow.

## Stranger mode

Raise a child with an adult you haven't met (spec: `docs/superpowers/specs/2026-07-31-coparent-matchmaking-design.md`, plan: `docs/superpowers/plans/2026-11-22-stranger-coparenting.md`). Code: `server/src/stranger/`, `server/src/routes/stranger.ts`, `client/src/components/StrangerMode.tsx`.

- **Off by default.** `RI_STRANGER_MODE=off` (or unset, or any unknown value) makes every `/api/stranger/*` route answer 404, and the client never shows the entry.
- **Meetup mode**: `RI_STRANGER_MODE=meetup` + `RI_MEETUP_CODES=code1,code2`. The entry shows only on `…/raising-intelligences/?meetup=code1`. Removing a code from the list shuts out passes already issued for it.
- **The hard line**: no minor reaches the stranger pool. Every player signs in with Matrix (verified server-side through Synapse OpenID userinfo), agrees to the ID-check consent, and passes Stripe Identity (document + live selfie, 18+ computed from the document's date of birth). Only the outcome is stored, the Identity session is redacted, a minor result is final for that account, and a test-mode check never admits anyone in production. Free solo play and the AI co-parent stay open to everyone.
- **Matching** (`server/src/stranger/matching.ts`): verified adults queue per meetup code; admission is re-checked at the moment of matching; pairs are first-come, first-served, skipping blocked pairs. The first queued is the **host**: parent1, names the child, and is the one charged if the partner paywall is on. Both seats are reserved for those two accounts only: every join needs the seat's own token plus the stranger pass of the adult it was matched to, and there are no invite links, seat reclaims or handoff codes in a stranger game. A reserved seat is not a seat (not in the game, not counted by the paywall) until its adult arrives. If one does not arrive within `RI_STRANGER_JOIN_WINDOW_MS` (default 3 min) their reservation lapses (one human, so nothing is ever due) and the one who came can requeue at their original place; if neither arrives the game is discarded and never opens again. Stranger games accept no REST writes (socket only). A queued player who stops polling for `RI_STRANGER_QUEUE_IDLE_MS` (default 90s) drops out of the queue. A seated player later found to be a minor, banned or suspended is put out at their next action.
- One ID document verifies one account (a keyed hash of its number is bound to the first account), and age is measured conservatively across time zones.
- Env: `RI_STRANGER_MODE`, `RI_MEETUP_CODES`, `RI_STRIPE_IDENTITY_KEY` (restricted `rk_` key only), `RI_STRIPE_IDENTITY_WEBHOOK_SECRET`, `RI_STRANGER_PEPPER` (**required**, 32+ bytes, `openssl rand -hex 32`; without it stranger mode stays off), `RI_IDENTITY_REDACT`.

## Architecture

### Tech

- **Frontend:** React 19, TypeScript, Vite 6, Socket.IO client
- **Backend:** Express 5, TypeScript, Socket.IO 4.8
- **Database:** PostgreSQL 16 (optional; in-memory fallback)
- **LLM:** OpenRouter API (OpenAI-compatible SDK)
- **Testing:** Vitest
- **Deployment:** Docker, Traefik, single-container production build

### LLM roles

The system uses multiple LLM roles, each mapped to specific models per tier:

| Role | What it does |
|------|-------------|
| `kid_family_chat` | Child's conversational replies (highest volume) |
| `kid_sidebar` | Child's replies in private parent-kid sidebar conversations |
| `world_manager` | Generates age-appropriate life events |
| `psychologist` | Updates the Identity Document after each event |
| `epilogue` | Writes the final life narrative |
| `report_card` | Generates the keepsake artifact |

**Model tiers:**

| Tier | Kid chat | Psychologist / Epilogue | Cost per game |
|------|---------|------------------------|--------------|
| `standard` | Qwen 3.7 Plus | Qwen 3.7 Max | ~$0.02 |
| `premium` | Gemini 2.5 Flash | Claude Opus 4.6 | ~$0.50 |

Set `MODEL_TIER=standard` (default) or `premium` in your `.env`. Both run on OpenRouter.

### Game state machine

```
lobby → event_intro → family_chat → processing → debrief
  ↑                                                    ↓
  └────────────────────────────────────────────────────┘
                                  (repeat 10–12 times)
                                      ↓
                                 epilogue → adult_chat → report_card → ended
```

The state machine lives in `server/src/game/state-machine.ts`. It enforces valid transitions and action ordering.

### Key files

```
server/src/
  index.ts                    # entry point, wires everything together
  app.ts                      # buildServer() dependency injection
  game/
    state-machine.ts          # phase transitions + action validation
    conversation-engine.ts    # orchestrates LLM calls per event
    endgame-engine.ts         # epilogue + report card generation
    context-assembler.ts      # builds prompts from game state
  llm/
    openrouter.ts             # OpenRouter API client
    model-config.ts           # per-role, per-tier model mapping
    prompts.ts                # all system prompts
  portrait-gen.ts             # AI image generation (background)
  socket/
    protocol.ts               # event names (shared with client)
    handlers.ts               # Socket.IO request handlers

client/src/
  App.tsx                     # root component, mode selection
  components/
    SoloGame.tsx              # solo game flow
    MultiplayerGame.tsx       # multiplayer flow with Socket.IO
    GuardianScreen.tsx         # the "I'm ready" screen
    ChildPortrait.tsx          # SVG portrait component
    admin/                    # admin dashboard (login, overview, game list, game detail)
  hooks/
    useGame.ts                # solo game state hook
    useMultiplayer.ts          # multiplayer state hook
    useAdminApi.ts            # admin API client with Bearer auth
```

---

## Running tests

```bash
npm test                    # unit + integration tests
npm run test:smoke          # end-to-end smoke test
```

E2E tests use a cassette/replay system — they hit a real server but replay recorded LLM responses so runs are fast and deterministic. Record new cassettes with `npm run test:e2e:record`.

---

## Deployment

The Dockerfile runs tests, builds both client and server, then serves everything from a single Express process:

```bash
docker build -t raising-intelligences .
docker run -p 3000:3000 \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e NODE_ENV=production \
  raising-intelligences
```

The production instance at `multiversegames.ai` uses Traefik for TLS routing. See `deploy/deploy.sh` for the full setup.

---

## Campus cabinet

Students on [campus.themultiverse.school](https://campus.themultiverse.school) can play RI in the Multiverse Games building's story corner. Campus opens `https://play.multiversegames.ai/raising-intelligences/?cabinet=campus` in an iframe.

- **Framing:** every response sends `Content-Security-Policy: frame-ancestors 'self' https://campus.themultiverse.school` and no `X-Frame-Options`. No other site can frame the game.
- **Cabinet mode** (`client/src/campusCabinet.ts`) is on only when the page is framed *and* the URL has `?cabinet=campus`. Outside it, nothing changes. In cabinet mode the client posts `mg:ready` to the campus origin, trades campus's `mg:pass` at `POST <base>api/campus-pass`, posts `mg:signed-in`, and sends the identity as `campusIdentity` when it creates or joins a game. The exchange URL comes from vite's configured base, never from `location`, so a pass cannot leave the page's origin. The pay-what-you-want prompt is hidden: a cabinet never asks for money.
- **Server:** `server/src/security/campus-pass.ts` verifies passes against the pinned campus public key (override: `CAMPUS_PASS_PUBLIC_KEY`). Each pass is single-use: its `jti` is spent in Postgres (`campus_pass_jti`). `server/src/routes/campus.ts` handles the exchange. The verified campus id feeds the child-safety vault as a verified identifier that a confirmed case bans; see "Verified campus identity" in `docs/child-safety.md`.

---

## Notes

- The game takes about an hour solo, two hours with two players, maybe three with three
- Each game generates roughly 70–200 LLM calls depending on how much you chat
- The Identity Document is the core artifact — the Psychologist writes it in the child's voice, and it evolves meaningfully across events
- Portrait generation runs in the background and doesn't block gameplay
- The sidebar mechanic in multiplayer is the intended way for the game to feel like a real relationship — not just a co-op mode

---

*"it turns out love isn't enough. and also it is."*
