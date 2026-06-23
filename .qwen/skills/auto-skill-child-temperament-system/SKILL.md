---
name: child-temperament-system
description: Implement persistent personality traits that influence AI character behavior across a game session
source: auto-skill
extracted_at: '2026-06-23T23:08:04.984Z'
---

# Child Temperament System

Children in interactive narratives shouldn't be generic NPCs—they need persistent personalities that create consistent behavioral patterns. This skill shows how to implement a temperament system where AI characters have distinct, enduring traits that shape how they respond to player actions.

## The Problem

When players interact with AI children in narrative games, the kids often:
- Are too easily "won over" by perfect parenting
- Don't have consistent personalities
- Are always endearing, even when real kids are cruel or difficult
- React the same way regardless of who they are as individuals

Real children have distinct temperaments. A stubborn child responds differently to boundaries than an anxious child. These patterns persist across situations and over time.

## The Solution

Assign each child a **temperament** at game start—a persistent personality profile that influences:
- How they respond to parent actions
- What situations create conflict
- How they learn and adapt over time
- What events are generated for them

## Implementation

### 1. Define Temperament Types

Create a curated set of distinct temperaments (typically 6-10):

```typescript
export const TEMPERAMENTS = [
  "Stubborn and defiant. You test limits constantly and don't accept 'no' easily. You're learning what buttons to push and when to escalate.",
  
  "Sensitive and anxious. You pick up on emotional tension quickly and can become overwhelmed. You need reassurance but also test whether people will actually be there for you.",
  
  "Charming but manipulative. You're learning how to get what you want through persuasion, guilt, or playing people against each other. You're not malicious — you're just figuring out how the world works.",
  
  "Strong-willed and independent. You have your own agenda and don't care much about what others think. You're not trying to be difficult — you just don't see why you should do what you're told.",
  
  "Withdrawn and observant. You watch more than you talk, but when you do speak, it cuts deep. You're learning people's patterns and storing that information for later.",
  
  "Impulsive and easily frustrated. You want things now and don't have the patience to wait. When you don't get your way, you escalate quickly.",
  
  "People-pleasing but resentful. You try to be good, but you're keeping score. You're learning that being 'good' doesn't always get you what you want, and you're starting to experiment with other strategies.",
  
  "Creative and dramatic. Everything is an event. You express yourself through elaborate stories, theatrical reactions, and creative problem-solving."
];
```

### 2. Store Temperament in Game State

Add temperament to the game state so it persists across all interactions:

```typescript
// server/src/game/state-machine.ts
export function createGame(): GameState {
  return {
    // ... other state
    temperament: TEMPERAMENTS[Math.floor(Math.random() * TEMPERAMENTS.length)],
  };
}

// server/src/types.ts
export interface GameState {
  // ... other fields
  temperament: string;
}
```

### 3. Inject Temperament into AI Prompts

Pass the temperament to every AI call that needs it:

**For the child's responses:**
```typescript
// server/src/game/context-assembler.ts
const system = `You are {childName}, a {age}-year-old child.

Your temperament: {temperament}

This is who you are. It doesn't change based on what your parents do. They can do everything right and you can still be difficult.

You have learned their patterns:
- What makes them give in
- What makes them frustrated  
- What buttons to push
- When they're about to cave

Use this knowledge. Test limits. Push back. You are not here to reward good parenting.

Even when parents do everything right, you might still:
- Be upset about it anyway
- Hold a grudge
- Say something cruel just to see what happens
- Act like it wasn't good enough

You cannot be "won over" by perfect parenting.`;
```

**For the psychologist's observations:**
```typescript
// Temperament influences how the Psychologist interprets behavior
const system = `You are the Psychologist observing {childName}.

Their temperament: {temperament}

Track how their personality evolves. Note what they've learned about their parents. Be realistic about the relationship dynamics.

A stubborn child might become more manipulative when they realize stubbornness doesn't work.
A sensitive child might become anxious if parents are inconsistent.
A people-pleaser might become resentful if they're never rewarded for being good.`;
```

**For the world manager:**
```typescript
// Generate events that challenge the specific temperament
const system = `You generate life events for {childName}.
  
Their temperament: {temperament}

Create situations that specifically test this child's personality:
- A stubborn child needs situations where stubbornness creates problems
- A sensitive child needs moments that overwhelm them
- A creative child needs opportunities for expression that get shut down

Make some situations unwinnable. Not every scenario has a good outcome.`;
```

### 4. Pass Temperament Through Context Builder

Ensure temperament flows to every AI call:

```typescript
export function buildContext(state: GameState, role: 'child' | 'psychologist' | 'world-manager') {
  // ... existing logic
  
  systemPrompt = systemPrompt
    .replaceAll('{temperament}', state.temperament);
    
  return {
    system: systemPrompt,
    messages: messageHistory
  };
}
```

## Key Design Principles

### 1. Temperament is Persistent, Not Deterministic

The temperament influences behavior but doesn't lock the character into one response. A stubborn child can still be sweet sometimes. An anxious child can still be brave occasionally.

**Do:** "Your temperament makes you more likely to..."
**Don't:** "You will always..."

### 2. Kids Can Be Difficult Even With Perfect Parenting

This is the most important principle. Real children:
- Have bad days regardless of parenting quality
- Say cruel things to test boundaries
- Push buttons to see what happens
- Can't be "won over" by doing everything right
- React based on their temperament, mood, and what they've learned

### 3. Kids Learn Parent Patterns

Children are pattern-recognition machines. They learn:
- What makes you give in
- What makes you lose patience
- When you're about to cave
- Which buttons to push
- What strategies work

**Teach the AI to use this knowledge:**
```
You've been paying attention to them for years. You know what buttons to push.
Sometimes you test limits even when you know the rules.
Sometimes you escalate to see if they'll really follow through.
```

### 4. Temperaments Can Evolve

Track how temperament changes over time. The psychologist should update notes about evolution:

```markdown
## Temperament at Age 3
Stubborn and defiant. Tests every limit.

## Temperament at Age 10
Still stubborn, but has learned to use logic and negotiation.
Has become more manipulative when direct defiance doesn't work.
```

### 5. Event Generation Should Challenge Temperament

The world manager should create situations that specifically test the child's personality:

| Temperament | Example Challenging Events |
|-------------|---------------------------|
| Stubborn | "Your child refuses to wear clothes you picked out, but it's the only clean option" |
| Sensitive | "Your child is overwhelmed at a birthday party with too many kids" |
| Manipulative | "Your child tells one parent the other said something they didn't actually say" |
| People-pleaser | "Your child is caught cheating on a test they studied hard for" |
| Withdrawn | "Your child won't talk about why they came home from school upset" |
| Impulsive | "Your child interrupts an important phone call repeatedly" |
| Creative | "Your child's artistic expression is messy/controversial/disruptive" |

### 6. Be Uncomfortably Specific in Prompts

Don't say "you can be difficult." Say:

```
You might say "I hate you" even when your parents are doing everything right.
You might refuse to eat dinner they spent an hour cooking.
You might throw a tantrum in public over something trivial.
You might say you love another caregiver more just to see the reaction.
You might take things for granted and then suddenly lash out.
```

The specificity makes the AI more likely to actually behave this way.

## Content Strategy for Temperaments

When writing temperament descriptions, include:

1. **Core trait** (What drives them)
2. **Behavioral patterns** (What they typically do)
3. **Learning goals** (What they're figuring out)
4. **Potential evolution** (How they might change)

Example:
```
Sensitive and anxious.

You pick up on emotional tension quickly and can become overwhelmed.
You need reassurance but also test whether people will actually be there for you.

You're learning:
- Which adults are reliable
- How to communicate when you're overwhelmed
- That anxiety doesn't always go away

You might become:
- More resilient if given consistent support
- More anxious if adults are inconsistent
- Withdrawn if your sensitivity is dismissed
```

## Testing the System

### Manual Testing

Create multiple games and verify:
1. Different games get different temperaments
2. The child's behavior is consistent with their temperament
3. The child remains difficult even with "good" parenting
4. The psychologist's notes reflect the temperament
5. World events challenge the specific temperament

### Automated Testing

Test that:
- Temperament is assigned on game creation
- Temperament appears in AI prompts
- Psychologist references temperament in observations
- Events are generated that match the temperament

## Common Pitfalls

### ❌ Making Kids Always Endearing

**Problem:** Kids are always sweet, grateful, or lovable—even when parents are doing everything "right."

**Solution:** Teach the AI that kids can be:
- Ungrateful despite sacrifices
- Cruel when testing boundaries
- Difficult for no apparent reason
- Manipulative to get what they want
- Resistant to change even when it's good for them

### ❌ Generic Responses

**Problem:** All kids respond similarly to the same parent actions.

**Solution:** Make responses temperament-specific. A stubborn child resists. A sensitive child withdraws. A manipulative child tries a different tactic.

### ❌ Temperament Changes Too Much

**Problem:** The child seems to have a different personality every interaction.

**Solution:** Temperament is the **baseline**. Mood, age, and learned behavior create variation around that baseline, but the core remains consistent.

### ❌ Everything Has a Solution

**Problem:** Every situation can be "won" with the right parenting approach.

**Solution:** Some situations are genuinely difficult regardless of what you do. The child's personality + the situation + their mood create outcomes you can't always control.

## Measuring Success

Users should report:
- "The kid feels real"
- "I can't always win, and that's frustrating but realistic"
- "The kid has a personality I can recognize"
- "Sometimes I do everything right and they're still difficult—which is how it actually is"

Track:
- Do users complete games with a "stubborn" child vs. a "people-pleaser" child?
- Do users adjust their approach based on the child's temperament?
- Do the psychologist's notes accurately reflect the personality evolution?

## When to Use This Pattern

This pattern works for any interactive narrative with AI characters that need:
- Distinct personalities
- Consistent behavior across sessions
- Realistic responses to player actions
- Character evolution over time
- Challenging (not just rewarding) interactions

It's especially effective when:
- Players invest emotional energy in relationships with AI characters
- The narrative is about growth/change over time
- You want to create genuine challenge (not just puzzle-solving)
- Realism is more important than optimization

## Related Skills

- **Loading States with Personality:** Use temperament-informed content to make loading screens feel connected to the specific child
- **Streaming and Prefetching:** Technical optimizations reduce actual wait time, while personality makes perceived wait time feel intentional
