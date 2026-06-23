---
name: readme-structure
description: Write READMEs that intrigue and explain how to run the project without revealing all implementation details
source: auto-skill
extracted_at: '2026-06-23T07:56:36.833Z'
---

# README Structure Pattern

When writing a README for a project that should intrigue and explain without overwhelming, follow this structure:

## 1. Opening Hook (2-3 sentences)
Start with the project's most compelling premise or a memorable quote. Don't explain everything - tease the interesting parts.

Example:
> An AI-powered narrative game where you raise a child from birth to adulthood.
> 
> You're raising a person who will outlive you. Every response you give shapes who they become — not just what they do, but how they understand themselves.

## 2. Live Demo Link
Immediately link to the working version so readers can try it.

```markdown
[Play now](https://.../)
```

## 3. "How it works" Section
Explain the high-level concept in 2-3 paragraphs. Focus on:
- What the user does (not implementation details)
- What makes it feel special/different
- What they get at the end

**Don't** explain:
- How it's implemented
- What databases/APIs it uses
- State machine details

## 4. Modes/Variants
Briefly list different ways to use it. One paragraph each, max.

Example:
> **Solo** — raise a child on your own.
> 
> **Multiplayer (2 players)** — co-parent with a friend, partner, sibling, ex.

## 5. Setup Section
Lead with the simplest possible setup. One command if possible:

```bash
npm install
npm run dev
```

Then mention what's required (Node version, etc.) and where to access it.

## 6. Optional Advanced Setup
If the project has optional components (database, external services), explain them briefly:

```bash
# If you want persistent storage
docker compose up -d
npm run migrate
```

## 7. Environment Variables
List required env vars with copy-paste instructions:

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY for LLM calls
```

## 8. Architecture Overview
Provide a high-level overview with:
- Tech stack (3-5 bullet points)
- Key concepts (not implementation details)
- A diagram or state machine if it helps understanding

**Include:**
- Tech stack (PostgreSQL, Express, etc.)
- What makes it interesting (e.g., "The Identity Document evolves across the entire game")
- File structure showing where to find important things

**Don't include:**
- How every feature is implemented
- Every endpoint and parameter
- Internal data structures

## 9. Running Tests
Simple command:

```bash
npm test              # unit + integration
npm run test:smoke    # end-to-end
```

## 10. Deployment
Brief instructions or link to deployment docs:

```bash
docker build -t myapp .
docker run -p 3000:3000 myapp
```

## 11. Closing Note
End with:
- A philosophical quote from/to
- Time estimates ("takes 15-25 minutes")
- Any interesting observations about usage

---

## Key Principles

1. **Lead with intrigue** - Don't explain everything in the first paragraph
2. **Setup is #1 priority** - Show people how to run it immediately
3. **Architecture is optional** - Include it but don't make it the focus
4. **Don't reveal all mechanics** - Tease interesting parts ("Identity Document") without explaining how they work
5. **Keep modes/variants brief** - One paragraph each
6. **One command to start** - If possible, `npm run dev` should be enough
7. **End on a human note** - Quotes, time estimates, or observations

---

## Anti-Patterns to Avoid

❌ Starting with "This is a [tech stack] application that does X"
❌ Explaining every feature in detail
❌ Putting architecture before setup
❌ Explaining how interesting mechanics work (let users discover)
❌ Using "Implementation Details" as a section header
❌ Making setup require multiple steps when one is possible

✅ Start with the compelling premise
✅ Show the simplest setup first
✅ Tease interesting parts without explaining them
✅ Keep architecture brief and scannable
✅ End with something memorable
