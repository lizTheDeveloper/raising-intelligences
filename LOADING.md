# Loading Pipeline

Measured locally against OpenRouter (claude-3.5-sonnet), 2026-06-23.
Raw timings from `scripts/measure-loading.mjs`.

---

## Measured timings

| Phase | Time | Notes |
|---|---|---|
| `POST /game` (create) | **12ms** | instant |
| Kid response per message | **4–8s** | streaming, feels fast |
| `POST /end-chat` (psychologist + prefetch) | **97–120s** | both LLM calls run in parallel |
| `POST /end-debrief` (state transition) | **1ms** | instant |
| `POST /next-event` after debrief | **0–1ms** | instant (prefetch was running during end-chat) |
| `POST /epilogue` | ~60–90s | streaming |
| `POST /report-card` | ~60–90s | streaming |

The slowest thing by far is the psychologist + world manager pair, which is why the processing screen exists.

---

## Before: sequential pipeline

```
player clicks "end conversation"
│
├──[PSYCHOLOGIST: ~70-90s]──────────────────────────────┐
│  player sees: identity doc leaking onto screen (bug)  │
│                                                        │
└── debrief screen shown                                 │
    player reads (~20s)                                  │
                                                         │
    player clicks "next chapter"                         │
    │                                                    │
    ├──[WORLD MANAGER: ~70s]─────────────────────────┐  │
    │  player sees: "generating next event…" spinner  │  │
    │                                                 │  │
    └── event_intro shown                             │  │
                                                      │  │
                                          total blocked: ~160s
                                          separate loading screens: 2
```

## After: parallel prefetch

```
player clicks "end conversation"
│
├──[PSYCHOLOGIST: ~70-90s]──────────────────────────────┐
│  player sees: fragments cycling at 10s each (8 total) │
│                                                        │
├──[WORLD MANAGER: ~70-90s]─────────────────────────┐   │  ← starts at T+0, parallel
│  hidden, no player-facing effect                   │   │
│                                                    ▼   ▼
└── debrief shown (both LLM calls are done here)
    player reads (~20s)

    player clicks "next chapter"
    │
    └── event_intro shown instantly (0–1ms) ← world manager was already done
```

**Result:** total blocked time ~100–120s (vs ~160s before), second loading screen eliminated, identity doc no longer leaks to player.

---

## What the player experiences per event

```
 T+0s    T+10s   T+20s   T+30s   ...  T+80s   T+97-120s
 │       │       │       │            │        │
 [frag1] [frag2] [frag3] [frag4]      [frag8]  [frag8 holds]
 ──────────────────────────────────────────────┤
                                               debrief appears
                                               (player clicks through)
                                               ↓
                                               next event: instant
```

8 fragments × 10s each = 80s of unique content.
Psychologist takes 97–120s, so fragment 8 holds for 17–40s at the end.
No fragment ever repeats within a session.

---

## Remaining latency the player notices

| Moment | Wait | What they see |
|---|---|---|
| First load (guardian screen) | ~70s | Portrait generating, fragments cycling |
| After each conversation | ~100s | Processing screen, fragments |
| Debrief → next event | **0ms** | Instant (prefetched) |
| Epilogue generation | ~60-90s | Streaming text |
| Report card | ~60-90s | Streaming text |

The guardian screen (~70s first load) is the one place that still feels long.
Portrait gen and first-event gen run in parallel, so the bottleneck is whichever is slower.
If OpenRouter latency improves or a faster model is used, this collapses proportionally.

---

## Model speed notes

These timings are on OpenRouter with claude-3.5-sonnet. They vary significantly:
- OpenRouter adds ~5–15s overhead vs direct Anthropic API
- Haiku or flash-tier models would cut psychologist time to ~15–25s, making the processing screen much shorter
- The world manager (event generation) benefits most from a faster model since it runs on every transition

To switch models, update `server/src/llm/model-config.ts`.
