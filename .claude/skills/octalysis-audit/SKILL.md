---
name: octalysis-audit
description: Evaluate game systems against Yu-kai Chou's Octalysis framework — score 8 core drives, identify white-hat gaps, flag dark patterns.
user_invocable: true
---

# Octalysis Game Audit

Evaluate game engagement through the 8 Core Drives of human motivation.

## The 8 Core Drives

| # | Drive | Hat | Description |
|---|-------|-----|-------------|
| 1 | Epic Meaning & Calling | White | Part of something greater |
| 2 | Development & Accomplishment | White | Progress, mastery, challenge |
| 3 | Empowerment of Creativity | White | Creative expression, responsive systems |
| 4 | Ownership & Possession | White | Building something yours |
| 5 | Social Influence & Relatedness | Neutral | Connection, mentorship, competition |
| 6 | Scarcity & Impatience | Black | Desire for rare/gated things |
| 7 | Unpredictability & Curiosity | Black | Wonder, discovery |
| 8 | Loss & Avoidance | Black | Protecting what you have |

**White Hat (1-4):** Primary targets. Players feel powerful and fulfilled.
**Black Hat (6-8):** Use sparingly. We never exploit attention.
**Prefer intrinsic (right-brain)** over extrinsic (left-brain) mechanics.

## Audit Process

1. Read game code and recent tickets for current state
2. Score each drive 0-10 based on implemented mechanics
3. Calculate White Hat Strength (Drives 1-4, max 40)
4. Identify weakest white-hat drives as improvement targets
5. Propose 1-3 improvements tied to specific drives
6. Flag black-hat drift (FOMO, artificial scarcity, loss anxiety)

## Design Principles

- Infinite games > finite games
- Learning and play are the point
- Emergence > prescription
- Respect player time — no dark patterns
- Community-driven evolution via Folkfork

## Output

```markdown
## Octalysis Audit: [Game] — [Date]

### Drive Scores
| Drive | Score | Key Mechanic | Gap |
|-------|-------|-------------|-----|
| 1. Epic Meaning | X/10 | ... | ... |
| ... | ... | ... | ... |

### White Hat Strength: X/40

### Proposals
1. **[Drive]: [Title]** — Mechanic, rationale, black-hat risk

### Black Hat Watch
- [Concerning patterns]
```

## Game Context

- **Precursors: Origins of Folklore** (`games/precursors`) — Creatures-inspired game where AI-driven beings with genetics, needs, and language evolve in a folkloric world. Key drives to nurture: Epic Meaning (ancient precursor mythology), Creativity (breeding, teaching), Unpredictability (emergent behavior), Ownership (your creatures, your world).
- **MVEE — Multiverse: The End of Eternity** (`games/mvee`) — hard sci-fi simulation with magic paradigms, ecology, divine systems, and civilization. Key drives: Epic Meaning (multiverse-scale stakes), Development (tech trees, civilization growth), Creativity (world-building, magic systems), Unpredictability (emergent civilizations).

## Cadence & Coordination

- Alternate between games each audit cycle; score from implemented mechanics — read game code plus recent MUL-#### tickets on the Paperclip board.
- Each proposal includes a black-hat risk assessment ("could this accidentally become manipulative?").
- Consult the lore lead for lore-driven engagement and the geneticist for breeding/evolution engagement; player-experience validation comes from playtesting/the board.
