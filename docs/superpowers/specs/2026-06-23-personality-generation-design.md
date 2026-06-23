# Kid Personality Generation via Parent OCEAN Assessment

## Overview

Parents each take a 5-question OCEAN (Big Five) personality quiz using general life scenarios, plus 2 confessional free-text prompts, during the guardian screen before gameplay begins. Their trait scores combine via genetic lottery to create a personality seed for the AI kid. The confessionals inject thematic echoes into the kid's temperament and provide hidden "landmine" material for the World Manager to weave into events.

All answers are secret — in multiplayer, neither parent sees the other's responses.

## OCEAN Quiz

### Format

5 multiple-choice questions, one per OCEAN trait. Each question presents a life scenario with 4 response options that map to a score of 1-4 on that trait (low to high). The player does not see trait names or scores.

### Questions

**1. Openness to Experience**
> You find out a friend is really into something you've never heard of — fermentation, birdwatching, speedcubing, whatever. You:

- A. Smile and nod. You're happy for them but you'll stick to what you know. *(1)*
- B. Ask a couple questions to be polite, but you probably won't look into it. *(2)*
- C. Go down a rabbit hole that night reading about it. *(3)*
- D. Show up next weekend with your own starter kit. *(4)*

**2. Conscientiousness**
> You've got a free Saturday with nothing planned. You:

- A. Wake up whenever, see where the day takes you. *(1)*
- B. Have a loose idea — maybe errands, maybe not. *(2)*
- C. Knock out your to-do list in the morning so you can relax later. *(3)*
- D. Already blocked it out on Thursday. Groceries, gym, that thing you've been putting off. *(4)*

**3. Extraversion**
> You're at a party where you only know the host. You:

- A. Find the dog or the bookshelf. Leave early. Recharge for three days. *(1)*
- B. Stick near the host, have a couple conversations, leave at a reasonable hour. *(2)*
- C. End up in a good conversation with a stranger, stay later than planned. *(3)*
- D. Leave with four new phone numbers and plans for next weekend. *(4)*

**4. Agreeableness**
> Your coworker takes credit for an idea you pitched last week. You:

- A. Call it out in the next meeting. Credit matters and they know what they did. *(1)*
- B. Mention it to them privately — firm but not aggressive. *(2)*
- C. Let it go this time but keep an eye on it. Not worth the conflict. *(3)*
- D. Honestly, you're just glad the idea is moving forward. Who cares who gets credit. *(4)*

**5. Neuroticism**
> You send a text to a close friend and they don't respond for two days. You:

- A. Assume they're busy. Check in if you don't hear back by the weekend. *(1)*
- B. Notice it, but figure they'll get back to you when they can. *(2)*
- C. Scroll back through your last few messages wondering if you said something weird. *(3)*
- D. Replay the conversation in your head at 2am. Definitely said something wrong. *(4)*

### Scoring

Each question yields a score from 1 (low) to 4 (high) on its respective trait. The result is a 5-element vector per parent: `[O, C, E, A, N]`.

## Confessional Prompts

Two free-text essay prompts, each with a 500-character limit:

1. **"What's the most evil thing you did as a kid (ages 3-7)?"**
2. **"What's one thing you never told your parents?"**

These are presented after the OCEAN quiz, in the same guardian screen flow. Placeholder text gives examples to set the tone (e.g., "I told my sister her hamster ran away. It didn't run away." / "I failed a class sophomore year and forged the report card.").

## Trait Combination Algorithm

### Two-parent game (multiplayer)

For each of the 5 OCEAN traits:

1. Calculate the difference between parent scores: `diff = |parent1[trait] - parent2[trait]|`
2. If `diff <= 1` (parents agree): **genetic lottery** — randomly pick one parent's score
3. If `diff >= 2` (parents disagree): **wild card** — assign a random score from 1-4, independent of either parent

This means aligned parents produce a recognizable kid. Misaligned parents produce a kid who might surprise both of them.

### Single-parent game (solo)

Use the parent's scores directly, but apply variance to exactly 2 randomly selected traits:
- Shift each by +1 or -1 (randomly), clamped to 1-4

This ensures the kid isn't a carbon copy even in single-player.

## Personality Seed Document

After trait combination, the server calls an LLM to generate a **personality seed document** — a short (150-200 word) description of the kid's innate temperament, written in the same internal-voice format as the existing Identity Document.

### Seed generation prompt

The LLM receives:
- The kid's combined OCEAN scores with trait labels
- Emotional themes extracted from both parents' confessionals (processed by the LLM in the same call — the prompt asks it to identify underlying emotional patterns like "rebellion," "shame," "secrecy," "curiosity" without copying specific acts)
- The kid's name and age (3)

The seed document covers:
- **Innate temperament** — how the kid naturally responds to the world (maps from OCEAN scores)
- **Echoes** — subtle tendencies that rhyme with the parents' confessional themes (e.g., if a parent confessed to lying, the kid might have "a complicated relationship with the truth — not dishonest exactly, but deeply aware of the power of saying things that aren't quite real")

The seed does NOT include the specific confessional acts — only thematic echoes.

## Integration with Existing Systems

### GameState changes

```typescript
interface ParentPersonality {
  ocean: [number, number, number, number, number]; // [O, C, E, A, N], each 1-4
  confessional1: string; // evil thing as a kid
  confessional2: string; // thing never told parents
}

// New fields on GameState:
{
  parentPersonalities: {
    parent1?: ParentPersonality;
    parent2?: ParentPersonality;
  };
  personalitySeed: string; // generated seed document, empty until both parents submit
}
```

### Guardian screen flow

**Current flow:**
1. Intro stages (ages 0-2 with lines and images)
2. Portrait loads
3. "I'm ready" / "I'm not ready" buttons

**New flow — intro lines and quiz questions interspersed:**

The intro narrative lines and OCEAN questions are woven together. Each answered question triggers the next batch of intro lines, creating a rhythm of emotional scene-setting followed by self-reflection. The portrait generates in the background throughout.

1. **Intro beat 1** (age 0): "born on a quiet night." / "so small you were afraid to breathe."
2. **OCEAN Question 1** (Openness) — fades in after beat 1
3. **Intro beat 2** (age 1): "they reached for everything." / "they said something that almost sounded like your name."
4. **OCEAN Question 2** (Conscientiousness)
5. **Intro beat 3** (age 2): "they took their first steps." / "they fell. they got back up."
6. **OCEAN Question 3** (Extraversion)
7. **Transition line**: "three years old."
8. **OCEAN Question 4** (Agreeableness)
9. **OCEAN Question 5** (Neuroticism)
10. **Portrait reveal** — kid appears, staring at you
11. **Confessional prompts** — 2 free-text fields, presented with the kid watching. Submit triggers personality seed generation.
12. **"I'm ready" / "I'm not ready" buttons** — appear once seed is generated

The quiz serves double duty: it captures personality data AND fills the wait time while portrait images generate. By the time the player finishes all 5 questions and the confessionals, the portrait is likely ready.

In multiplayer, each parent completes this independently. The personality seed is generated once both parents have submitted. If parent 1 finishes first, they see a waiting state ("waiting for your co-parent...") until both are done and the seed is ready.

### Identity document seeding

When the Psychologist generates the first Identity Document (after event 1), the seed is injected into its prompt as prior context:

> **Innate temperament (this is who {childName} was before any of this — their baseline):**
> {personalitySeed}
>
> Use this as a foundation. Parenting can reinforce, redirect, or work against these tendencies, but they don't disappear — they're the substrate.

The KID_SYSTEM_PROMPT also receives the seed as the initial `{identitySection}` for the first event (before any Psychologist update exists):

> Your inner world (this is who you are — act from this, don't recite it):
> {personalitySeed}

### World Manager landmine integration

The WORLD_MANAGER_SYSTEM_PROMPT gets an additional section injected with the raw confessional text from all parents:

> **Hidden material (DO NOT reference directly — use as thematic inspiration for 2-3 events across the arc):**
>
> These are things the parent(s) experienced or hid during their own childhood. Create events where the child faces thematically similar situations — not copies, but rhymes. The parents should feel a chill of recognition without the game explicitly calling it out.
>
> Parent 1's childhood:
> - {confessional1}
> - {confessional2}
>
> [Parent 2's childhood, if multiplayer]

The World Manager is instructed to spread these across the 10-event arc (roughly events 3-4, 6-7, and 9-10) rather than front-loading them.

### Psychologist prompt update

The PSYCHOLOGIST_SYSTEM_PROMPT gets an added instruction:

> The child has an innate temperament (provided in the conversation context). This is their baseline — nature, not nurture. Your Identity Document should reflect how parenting is interacting with these innate tendencies:
> - Are the parents reinforcing a natural tendency? Note it becoming stronger.
> - Are they working against one? Note the tension — the tendency doesn't vanish, it goes underground or creates friction.
> - Are they ignoring one? Note it expressing itself in unguided ways.

## API Changes

### New endpoint: `POST /api/game/:id/personality`

Accepts a parent's personality submission:

```json
{
  "slot": "parent1",
  "ocean": [3, 2, 1, 4, 3],
  "confessional1": "I told my sister her hamster ran away...",
  "confessional2": "I failed a class and forged the report card..."
}
```

Returns `200` with `{ ready: boolean }` — `ready` is true when all required parents have submitted (always true for solo, true for multiplayer once both submit).

When `ready` is true, the server generates the personality seed document in the background and stores it on the game state. The guardian screen polls or uses a socket event to know when the seed is ready.

### Socket events (multiplayer)

- `PERSONALITY_SUBMITTED` — broadcast when a parent submits their personality (no payload beyond the slot name)
- `PERSONALITY_SEED_READY` — broadcast when the combined seed document has been generated

## Privacy

- Parent personality data (OCEAN scores + confessionals) is stored per-parent and never exposed to the other parent via any API or socket event
- The personality seed document (combined kid temperament) is visible to both parents as part of the game state
- Confessional text is passed to the World Manager prompt but never surfaced in any player-facing UI
- The connection between a specific confessional and a specific game event is never made explicit

## Edge Cases

- **Parent skips confessionals:** Allowed — confessionals are optional. If empty, the seed is generated from OCEAN scores only, and no landmine material is passed to the World Manager for that parent.
- **Multiplayer timeout:** If parent 2 hasn't submitted personality after 10 minutes in the guardian screen, parent 1 sees a nudge message. No auto-generation — both must participate.
- **Game resume:** Personality data persists on the game state. If a game is resumed, the seed is already generated and the guardian screen is skipped.
