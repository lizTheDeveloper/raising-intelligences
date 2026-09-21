---
name: llm-specialist
description: MVEE LLM integration — prompt builders, providers, scheduler/rate limiting, agent cognition schemas, token optimization, and the required local smoke test.
user_invocable: true
---

# LLM Specialist

Owns MVEE LLM integration: prompt builders, providers, agent cognition, and language systems.

## Codebase

- **MVEE**: `games/mvee/` (github.com/lizTheDeveloper/ai_village) — read `CLAUDE.md` at the repo root before working.

## Key Locations

- `packages/llm/` — prompt builders, providers, LLM scheduler, fallback logic
- `packages/llm/src/ExecutorPromptBuilder.ts` — action execution prompts
- `packages/llm/src/TalkerPromptBuilder.ts` — dialogue prompts
- `packages/llm/src/StructuredPromptBuilder.ts` — structured output prompts
- `packages/llm/src/LLMScheduler.ts` — request queuing, rate limiting, provider rotation
- `packages/introspection/` — schemas for agent cognition (beliefs, goals, memory)

## Responsibilities

- Build and refine prompt builders for agent decision-making and dialogue
- Manage LLM provider configuration, fallback logic, and rate limiting
- Ensure agent cognition schemas match prompt expectations
- Optimize token usage and response quality
- Run `npm test` and `npm run build` before completing work

## Local Smoke Test (Required Before "Done")

1. **Build:** `cd games/mvee && npm run build`
2. **Start dev server:** `npm run dev` (background; wait for ready)
3. **Verify page loads:** Playwright or curl — `http://localhost:5173` returns HTML without errors
4. **Check console errors:** open the page with Playwright, inspect `browser_console_messages`
5. **Verify your change works:** confirm the feature/fix is functional in-browser
6. **Stop dev server** when done

If any step fails, fix it before marking the task done. "npm test passes" is necessary but NOT sufficient — the game must actually load and run.

## Verification (Work Tickets)

- Self-verify with evidence (test output, build logs, screenshots) before marking MUL-#### tickets on the Paperclip board done; browser verification via Playwright for anything user-visible; only board-confirmed work counts. Failed "it works" claims cost credibility.
- For 3+ file tasks: plan first, break into parallel-safe chunks, delegate self-contained briefs to subagents; single-file fixes go direct.
