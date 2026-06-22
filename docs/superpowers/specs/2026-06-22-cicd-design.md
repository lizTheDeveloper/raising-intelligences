# CI/CD + Infrastructure Design
*2026-06-22*

## Overview

Auto-deploy Raising Intelligences to Hetzner on every merge to `main`, gated on passing tests. No GitHub Actions. Coolify (already running on the server) handles the full pipeline.

---

## Infrastructure

All services run on the Hetzner box at `multiversegames.ai`, managed by Coolify with Traefik routing.

| Service | Description | Public Domain |
|---|---|---|
| **Raising Intelligences app** | Node.js API + React client (single container) | `multiversegames.ai` |
| **Postgres (game)** | Game state, users, sessions, credits | internal |
| **Langfuse** | Self-hosted LLM observability | `langfuse.multiversegames.ai` |
| **Postgres (Langfuse)** | Dedicated DB for Langfuse | internal |
| **Traefik** | Reverse proxy — already running | — |

---

## CI/CD Flow

1. Merge PR to `main` on GitHub
2. GitHub webhook fires → Coolify receives it
3. Coolify runs **pre-deploy command**: `npm run test -w server`
   - All 22 Vitest tests must pass
   - On failure: deploy aborts, container is not restarted, old version keeps serving
4. Coolify builds the Docker image (multi-stage, see below)
5. Coolify restarts the app container
6. Traefik routes traffic to the new container automatically

---

## Dockerfile (multi-stage)

Three stages:

**Stage 1 — build-client**
- Base: `node:20-alpine`
- Install all deps (`npm ci`)
- Run `npm run build -w client` → outputs `client/dist/`

**Stage 2 — build-server**
- Base: `node:20-alpine`
- Install all deps
- Compile TypeScript: `npm run build -w server` → outputs `server/dist/`

**Stage 3 — production**
- Base: `node:20-alpine`
- Copy `server/dist/` and production `node_modules`
- Copy `client/dist/` into the server's static file serving path
- `CMD ["node", "dist/index.js"]`

The server already includes static file middleware to serve `client/dist/` at `/` and the API at `/api`.

---

## Environment Variables (game app)

Set in Coolify's environment variable UI. `DATABASE_URL` is auto-injected when the Coolify Postgres service is linked.

| Variable | Source |
|---|---|
| `OPENROUTER_API_KEY` | Set manually in Coolify |
| `DATABASE_URL` | Auto-injected by Coolify (game Postgres) |
| `LANGFUSE_HOST` | URL of self-hosted Langfuse (e.g. `https://langfuse.multiversegames.ai`) |
| `LANGFUSE_PUBLIC_KEY` | From self-hosted Langfuse project settings |
| `LANGFUSE_SECRET_KEY` | From self-hosted Langfuse project settings |
| `NODE_ENV` | `production` |
| `PORT` | Port the server listens on (e.g. `3000`) |

---

## Langfuse Self-Hosted Setup

Use **Langfuse v2** (not v3). v3 adds a ClickHouse dependency that's resource-heavy for a single server; v2 runs on Postgres alone, which is sufficient for this scale.

Langfuse is deployed as a separate Coolify service using the official Langfuse v2 Docker image. It requires:

- Its own Postgres instance (separate from the game DB), deployed alongside Langfuse as a Docker Compose stack in Coolify
- Traefik routing for `langfuse.multiversegames.ai`

After Langfuse is running, create a project inside it and copy the public/secret key pair into the game app's environment variables.

---

## Coolify Configuration Steps (implementation detail)

1. **Connect GitHub repo** — add GitHub App or personal access token in Coolify settings
2. **Create Postgres service (game)** — name it `ri-postgres`
3. **Create app** — point to `github.com/lizTheDeveloper/raising-intelligences`, branch `main`
   - Build pack: Dockerfile
   - Pre-deploy command: `npm run test -w server`
   - Link `ri-postgres` → injects `DATABASE_URL`
   - Set remaining env vars
   - Domain: `multiversegames.ai`
4. **Deploy Langfuse** — use Coolify one-click or manual Docker Compose service (Langfuse + Postgres only, no Redis needed)
   - Domain: `langfuse.multiversegames.ai`
5. **Copy Langfuse keys** into game app env vars, redeploy

---

## Local Development vs Production

`db/docker-compose.yml` (from the PR) is for local development only — it spins up a local Postgres. In production, Coolify manages Postgres as a service. The `DATABASE_URL` env var is the only thing that changes between environments.

---

## What's Not In Scope

- Client-side tests (none exist yet — add to pre-deploy command when they do)
- Staging environment
- Blue/green or zero-downtime deploys (Coolify restarts in-place; acceptable for early-stage)
- Database migrations run on app startup via `server/src/db/migrate.ts` — no separate migration step needed
