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
- `ADMIN_TOKEN` — optional, enables the admin dashboard at `/raising-intelligences/admin` (requires `DATABASE_URL`)

The server works without any of these, but LLM calls will fail without an API key.

---

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
| `cerebras` | GPT OSS 120B (Cerebras) | GPT OSS 120B | ~$0.00 |
| `premium` | Gemini 2.5 Flash | Claude Opus 4.6 | ~$0.50 |

Set `MODEL_TIER=standard` (default), `cerebras`, or `premium` in your `.env`.

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

## Notes

- The game takes about an hour solo, two hours with two players, maybe three with three
- Each game generates roughly 70–200 LLM calls depending on how much you chat
- The Identity Document is the core artifact — the Psychologist writes it in the child's voice, and it evolves meaningfully across events
- Portrait generation runs in the background and doesn't block gameplay
- The sidebar mechanic in multiplayer is the intended way for the game to feel like a real relationship — not just a co-op mode

---

*"it turns out love isn't enough. and also it is."*
