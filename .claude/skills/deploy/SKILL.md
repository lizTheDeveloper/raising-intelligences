---
name: deploy
description: Build, bundle, and deploy Multiverse Games to production (Hetzner). Covers Vite builds, stale .js cleanup, start.sh, and production deployment.
user_invocable: true
---

# Deploy — Build & Ship to Production

Use this skill when you need to build, bundle, or deploy any Multiverse Games project.

## Quick Reference

```bash
# Game root
cd /Users/annhoward/src/multiverse_games/games/mvee

# Dev server
./start.sh              # Full game host (HMR enabled)
./start.sh server       # Backend only
./start.sh status       # Check running servers
./start.sh kill         # Stop all

# Build & test (MUST pass before deploy)
npm run build           # TypeScript check
npm test                # Unit tests

# Production bundle
npm run build:prod      # Vite production bundle for Hetzner
```

## Pre-Deploy Checklist

1. **Clean stale .js files** — TypeScript sometimes outputs .js to src/, causing Vite to serve stale code:
   ```bash
   find custom_game_engine/packages -path "*/src/*.js" -type f -delete
   find custom_game_engine/packages -path "*/src/*.d.ts" -type f -delete
   ```
2. **Build must pass** — `npm run build` with zero errors
3. **Tests must pass** — `npm test` with zero failures
4. **No console.log debug output** in production code

## Production Deployment (Hetzner)

The production server hosts play.multiversestudios.xyz. SSH alias: `ssh hetzner`.

**Critical:** The Hetzner box also runs theMultiverse.school (the revenue engine). Be extremely careful with any changes that affect shared infrastructure.

### Deploy Strategy

- All services run as containers on Hetzner
- Deploy should be automated via CI/CD where possible
- After deploy, verify the game loads at play.multiversestudios.xyz

## When NOT to Restart Dev Server

HMR handles .ts changes in 1-2 seconds. Only restart for:
- `npm install` (new dependencies)
- Config file changes (vite.config, tsconfig, etc.)
- Server crashes
- Stale .js file contamination

## Example: Full Deploy Flow

```bash
cd /Users/annhoward/src/multiverse_games/games/mvee

# 1. Clean
find custom_game_engine/packages -path "*/src/*.js" -type f -delete
find custom_game_engine/packages -path "*/src/*.d.ts" -type f -delete

# 2. Build & test
npm run build && npm test

# 3. Production bundle
npm run build:prod

# 4. Deploy to Hetzner
ssh hetzner  # then follow container deploy procedure
```
