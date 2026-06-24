---
name: age-specific-prompts
description: Use age-based prompt selection instead of monolithic prompts to improve tone and context appropriateness for AI-generated content
source: auto-skill
extracted_on: 2026-06-23
---

# Age-Specific Prompts Pattern

## Problem

When building AI systems that interact with characters of different ages (children, teens, adults), using one large prompt that tries to cover all age ranges results in:
- Poor tone matching (LLM can't decide which age-appropriate behavior to use)
- Inconsistent responses across the age spectrum
- Difficulty maintaining developmental appropriateness
- LLM trying to balance conflicting guidance

## Solution

Create separate, focused prompts for specific age ranges and select the appropriate one based on the character's current age. Each prompt includes only relevant guidance for that developmental stage.

## Implementation

### 1. Create Age-Based Prompt Modules

```typescript
// age-specific-prompts.ts

const PROMPT_4_5 = `You are a {age}-year-old child...`;
const PROMPT_6_7 = `You are a {age}-year-old child...`;
// ... more age groups

export function getAgeSpecificPrompt(age: number, vars: { childName: string }): string {
  let prompt: string;
  
  if (age <= 5) {
    prompt = PROMPT_4_5;
  } else if (age <= 7) {
    prompt = PROMPT_6_7;
  } else if (age <= 9) {
    prompt = PROMPT_8_9;
  } // ... continue pattern
  
  // Interpolate variables
  return prompt
    .replaceAll('{age}', String(age))
    .replaceAll('{childName}', vars.childName);
}
```

### 2. Update Context Assembler

Replace monolithic prompt usage with age-specific selection:

```typescript
// Before
const system = fillTemplate(MONOLITHIC_KID_PROMPT, {
  childName: state.childName,
  age: String(state.currentEvent?.age ?? 4),
});

// After
const system = getAgeSpecificPrompt(state.currentEvent?.age ?? 4, {
  childName: state.childName,
});
```

### 3. Remove Obsolete Monolithic Prompt

Delete the old single-prompt approach to avoid confusion.

## Age Group Guidelines

### Early Childhood (4-5)
- Simple, concrete thinking
- Focus on immediate needs and emotions
- Limited vocabulary, short attention span
- Responds to redirection and comfort

### Middle Childhood (6-9)
- Developing logic and reasoning
- Can articulate feelings more clearly
- Understands cause and effect
- Responds to explanation and negotiation

### Adolescence (13+)
- Complex emotions and identity exploration
- Can engage in nuanced discussion
- Tests boundaries thoughtfully
- Needs respect and relational connection

## Benefits

- **Better tone matching**: Each prompt is tailored to developmental stage
- **More consistent output**: LLM has clear, focused guidance
- **Easier maintenance**: Updates to one age group don't affect others
- **Improved user experience**: Characters feel more authentic

## When to Use This Pattern

- Games involving character aging over time
- Educational apps with age-appropriate content
- Any system generating content for multiple age groups
- When you notice tone inconsistencies across age ranges
