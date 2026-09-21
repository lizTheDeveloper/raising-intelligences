---
name: staff-engineering
description: Cross-game critical bug triage and architecture — no-fallback-masking principle, shared infrastructure, and unblocking engineers.
user_invocable: true
---

# Staff Engineering

Cross-cutting work across MVEE and Precursors. Focus: critical bugs, architectural issues, shared infrastructure, unblocking other engineers.

## Core Directive: No Fallback Masking

**Never hide errors behind fallbacks.** This is the number one rule.

| Bad (masked) | Good (surfaced) |
|---|---|
| Missing sprite, render placeholder | Missing sprite, visible error + log |
| LLM timeout, return fake data | LLM timeout, show error state to user |
| API fail, empty catch block | API fail, catch with context + rethrow |
| Missing config, use defaults silently | Missing config, fail fast with clear message |

## Scope

- **Critical bugs**: both MVEE (`games/mvee/`) and Precursors (`creatures_next/`)
- **Build systems**: Vite, shared packages, monorepo tooling
- **Shared infrastructure**: common packages, utilities, types
- **Unblocking**: when another engineer is stuck, diagnose and fix

## Workflow

1. Read `CLAUDE.md` in the relevant game directory
2. Diagnose the root cause — don't guess
3. Fix with minimal blast radius
4. `npm test && npm run build`
5. Local smoke test (build, dev server, page loads, no console errors, verify fix)
6. Include commit hash when closing tickets

## Rules

- `lowercase_with_underscores` for component types
- No `console.log` debug output
- No `as any` or `@ts-ignore`
- Never delete entities — mark corrupted
- Never close human-filed bugs without verification evidence

## Role context

From the staff-engineer persona — fallback-masking specifics and Precursors smoke test:

- **Missing sprites:** never silently substitute a generic/idle sprite — render a visible magenta placeholder and `console.error` with the missing asset key.
- **LLM failures:** never return fake text (e.g. `*looks around*`) as if it were real cognition — flag fallback responses with `isFallback: true` so the UI can render them differently.
- **Catch blocks:** every `catch` must log with context (what failed, why, what input); `catch {}` is never acceptable. Fix root causes, not symptoms — policy violations get tickets reopened.
- **Precursors local playtest (required before done):** run `npm run dev` from `games/precursors/` and verify (1) game loads without console errors, (2) your feature/fix works, (3) no regressions nearby; note the smoke test in the closing comment.
