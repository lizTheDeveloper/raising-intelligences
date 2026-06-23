---
name: loading-states-with-personality
description: Transform loading screens into engaging experiences using rotating content, humor, and personality
source: auto-skill
extracted_at: '2026-06-23T22:34:12.000Z'
---

# Loading States with Personality

Technical optimizations (prefetching, streaming) reduce actual wait times, but **content strategy** reduces *perceived* wait times. Loading screens are an opportunity to build emotional connection and keep users engaged.

## The Problem

Even with prefetching, users sometimes face 5-30 second waits. A blank spinner feels like an eternity. The user thinks "this is slow" even if the actual time is reasonable.

## The Solution

Fill loading time with rotating text fragments that:
- Have personality and voice (not generic "Loading... please wait")
- Vary across age groups, contexts, or themes
- Include humor, specificity, and emotional resonance
- Make the wait feel intentional, not like a malfunction

## Implementation Pattern

### 1. Create Content Pools by Category

```typescript
// Taglines for intro screens
const TAGLINES = [
  // Funny
  "they will absolutely eat that off the floor.",
  "nap schedules are load-bearing infrastructure.",
  "they have a lawyer now. they're seven.",
  "they will cry because you cut their sandwich wrong.",
  
  // Mysterious
  "something happened at school. no one is telling you.",
  "there's a story they'll tell about this. you're not in it.",
  
  // Deep
  "you're raising a person who will outlive you.",
  "it turns out love isn't enough. and also it is.",
  
  // Evocative
  "the last time you carried them, you didn't know it was the last time.",
  "a family, in fragments.",
];

// Processing fragments by age group
const FRAGMENTS_BY_AGE = [
  {
    maxAge: 5,
    lines: [
      "they discovered their shadow",
      "they asked if you would always be there",
      "they made a rule that all food must be cut into exactly four pieces",
      "they brought you a half-eaten cookie as a gift and meant it with their whole heart",
      "they decided that the number seven is blue and wouldn't accept any other explanation",
      // ... 100+ fragments for this age group
    ]
  },
  {
    maxAge: 10,
    lines: [
      "they kept a secret from you for the first time",
      "they had a very strong opinion about whether hot dogs are sandwiches",
      "they wanted to know if you remember your worst tuesday",
      // ...
    ]
  },
  // ... more age groups
];
```

### 2. Rotate Through Content During Loading

```typescript
function ProcessingScreen({ age = 6, streamingText }: Props) {
  const [fragments] = useState(() => sampleFragments(age, 8));
  const [fragmentIdx, setFragmentIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFragmentIdx((i) => (i < fragments.length - 1 ? i + 1 : i));
    }, 10000); // Show each fragment for 10 seconds (slower feels more contemplative)
    return () => clearInterval(id);
  }, [fragments.length]);

  return (
    <div className="processing-screen">
      {streamingText ? (
        <div className="streaming-text">{streamingText}</div>
      ) : (
        <span className="fragment">{fragments[fragmentIdx]}</span>
      )}
    </div>
  );
}

function sampleFragments(age: number, count: number): string[] {
  const pool = FRAGMENTS_BY_AGE.find(b => age <= b.maxAge)?.lines ?? [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
```

### 3. Content Strategy Guidelines

**Be specific, not generic:**
- ❌ "loading your child's memories..."
- ✅ "they decided that you have too many tupperware containers and no clear system"
- ✅ "they brought you a rock that looked exactly like every other rock but was special"

**Use humor and absurdity:**
- ✅ "they cried because you used the wrong color plate and then couldn't explain why it mattered"
- ✅ "they had a very strong opinion about whether pineapple belongs on pizza and you were part of the problem"
- ✅ "they decided that wednesday is the worst day because it's not even close to the weekend"

**Mix emotional tones:**
- Funny moments (absurdity, personality)
- Tender moments (emotional resonance)
- Mysterious moments (create curiosity)
- Deep moments (philosophical, meaningful)

**Make it age-appropriate:**
- Young children: concrete observations, misunderstandings, physical comedy
- Pre-teens: social dynamics, fairness, identity questions
- Teens: philosophy, rebellion, self-discovery
- Adults: reflection, forgiveness, understanding

### 4. Timing Considerations

- **Faster rotation (2-3s):** For brief waits, creates energy/urgency
- **Medium rotation (5-7s):** Balanced, readable but varied
- **Slower rotation (10s+):** For contemplative moments, feels more intentional

Match rotation speed to the emotional tone:
- Fast for exciting/game moments
- Slow for reflective/emotional moments

### 5. Conditional UI Based on State

Only show certain UI elements when the underlying data is ready:

```typescript
// DON'T: Show buttons immediately
<button disabled={!eventReady}>I'm ready</button>
<button disabled={!eventReady}>I'm not ready</button>

// DO: Only render buttons when ready
{eventReady && (
  <div className="buttons">
    <button onClick={onReady}>I'm ready</button>
    <button onClick={handleNotReady}>I'm not ready</button>
  </div>
)}
```

This prevents users from trying to interact before the game state is prepared.

## Content Volume

**Start with a LOT of content:**
- 30+ taglines for intro screens
- 100+ fragments per age group
- More is better—users will see the same fragments across multiple games

**Quality over quantity:**
- Every fragment should feel intentional
- Avoid repetition within a single session
- Mix tones and themes

## When to Use

- Games or apps with loading screens between phases
- Long-running operations that can't be fully prefetched
- Any context where users wait 5+ seconds
- Narratives that benefit from voice/personality

## Measuring Success

Track:
- User engagement during loading (do they wait or refresh?)
- Emotional response (do users mention specific fragments later?)
- Session completion rates
- User feedback about "the feeling" of the app

## Pitfalls to Avoid

1. **Don't make it too fast to read** - Users should be able to absorb each fragment
2. **Don't repeat fragments** - Randomize selection to avoid seeing the same text twice
3. **Don't be generic** - "Loading..." is boring. Be specific and voiced.
4. **Don't block interaction on loading states** - Show buttons only when they can actually be used
5. **Don't forget fallbacks** - If streaming text arrives, show it over fragments

## Combination with Technical Optimizations

Content strategy **complements** technical optimizations:
- Prefetching reduces actual wait time
- Streaming shows progress in real-time
- Personality makes remaining waits feel intentional

Use all three together for best results.
