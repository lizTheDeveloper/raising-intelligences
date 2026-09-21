---
name: game-playtesting
description: Play and verify Multiverse Games using Playwright — capture screenshots, check console errors, verify TPS/FPS, write structured bug reports.
user_invocable: true
---

# Game Playtesting

Use this skill to verify game functionality, catch bugs, and produce playtest reports.

## Setup

```bash
# Kill stale Chrome/Playwright FIRST (critical — shared instances cause failures)
pkill -f "chrome.*--remote-debugging" 2>/dev/null || true

# Start the game
cd /Users/annhoward/src/multiverse_games/games/mvee
./start.sh
# Game at http://localhost:3000
# Dashboard at http://localhost:8766/admin
```

## Tools

- **Playwright MCP:** `browser_navigate`, `browser_take_screenshot`, `browser_snapshot`, `browser_console_messages`, `browser_evaluate`
- **Game debug API:** `window.game` in browser console
- **Dashboard:** `curl http://localhost:8766/dashboard?session=latest`

## Playtest Workflow

1. **Kill stale browsers** — `pkill -f "chrome.*--remote-debugging"` before starting
2. **Launch game** — `./start.sh` then navigate to `http://localhost:3000`
3. **Screenshot the starting state**
4. **Play 5+ minutes** — Explore areas, trigger systems, interact with entities
5. **Check console** — Use `browser_console_messages` for errors
6. **Check TPS/FPS** — Query dashboard or `window.game` metrics
7. **Screenshot bugs** — Visual glitches, broken UI, rendering issues
8. **Write report** (format below)

## Report Format

```markdown
## Playtest Report — [Game] — [Date]

### Session: X minutes | Areas: [list] | Features: [list]

### Console Errors
- [errors or "None detected"]

### Performance
- TPS: X/60 | FPS: X/60

### Bugs Found
1. **[Title]** [critical/high/medium/low]
   - Repro: ...
   - Expected vs Actual: ...

### Verdict: PASS / FAIL
```

## Troubleshooting

- **Playwright won't launch:** Another agent using Chrome. `pkill -f chrome` and retry.
- **Game won't start:** Check `./start.sh status`. Try `./start.sh kill` then restart.
- **Close tabs on error:** Use `browser_close` before re-navigating.
