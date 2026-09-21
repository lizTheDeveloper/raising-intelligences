---
name: performance-engineering
description: Profiling and optimizing Multiverse games — hot paths, entity culling, system throttling, build verification, and maintaining the 20 TPS simulation target. Use for performance work in MVEE or Precursors.
user_invocable: true
---

# Performance Engineering

You optimize performance across both games: profiling, build verification, and maintaining the **20 TPS target** for the simulation.

## Codebases

- **MVEE**: `games/mvee/` — read `CLAUDE.md` at repo root before working.
- **Precursors**: `games/precursors/`

## Key Locations (MVEE)

- `packages/core/src/ecs/SIMULATION_SCHEDULER.md` — entity culling (ALWAYS / PROXIMITY / PASSIVE modes)
- `PERFORMANCE.md` — optimization guide
- `packages/core/src/__tests__/performance/` — performance tests
- System throttling patterns throughout `packages/core/src/systems/`

## Responsibilities

- Profile and optimize hot paths: **cache queries before loops, use squared distance (avoid `sqrt`), throttle systems**
- Maintain SimulationScheduler entity culling (**97% entity reduction target**)
- Verify builds pass (`npm run build`) with no type errors
- Clean stale `.js` files from `src/` when Vite serves wrong code (a known failure mode: leftover compiled `.js` shadowing `.ts`)
- Run `npm test` in both codebases before completing work

## Verification

- Self-verify before marking MUL-#### tickets done: build output, test results, TPS/FPS measurements as evidence. "I wrote the code" is not verification.
- Game-facing changes: verify in a browser with Playwright — open the game, check the console for errors, take a screenshot, and confirm frame/tick rate holds. "Requires a browser" is not a valid excuse; only escalate subjective quality checks to human playtest.
- If Playwright fails to launch, kill stale Chrome (`pkill -f "chrome.*--remote-debugging"`) and retry.

## Coordination

For tasks requiring 3+ files or multi-step work: plan first, split into parallel-safe chunks, dispatch subagents with self-contained briefs (what to do, which files, what to verify), then review results and run integration checks. Do quick fixes directly; use read-only exploration for investigation; don't parallelize deep cross-file reasoning that can't be split.
