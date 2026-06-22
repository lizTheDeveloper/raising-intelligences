---
name: project-monetization-analysis
description: Raising Intelligences monetization strategy completed 2026-06-22 — freemium pay-per-game model recommended, key architecture seams identified
metadata:
  type: project
---

Comprehensive monetization analysis delivered for Raising Intelligences on 2026-06-22.

Key decisions and findings:
- Recommended model: freemium with pay-per-game ($4.99/game, first game free at 4-5 events)
- Subscription explicitly flagged as poor fit due to high marginal API cost per session
- Bottom-up LLM call count: 104-323 calls per game (not 30-50 as initially estimated)
- Model tiering (Haiku for Kid, Sonnet for World Manager/Psychologist, Opus for Report Card) reduces costs 40-60%
- Cardinal anti-pattern: never paywall the emotional payoff (epilogue/report card) after sunk time investment
- Six architecture seams recommended to build now: per-game cost tracking, account FK, entitlement gate, model config externalization, billable/free route separation, report card as standalone artifact

**Why:** Developer is building the game now and needs monetization hooks designed in from the start rather than retrofitted.

**How to apply:** Reference these findings when the developer asks about pricing, architecture decisions, or feature prioritization related to monetization.
