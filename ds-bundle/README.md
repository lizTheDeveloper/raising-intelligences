# Raising Intelligences — Design System

A minimalist literary terminal aesthetic for a narrative parenting game. Every screen is a dark, monospace, text-driven experience — quiet, contemplative, and intimate. There are no bright colors, no icons, no images (except generated child portraits), no cards or containers with visible borders. The child's voice is the only color accent in the entire UI.

## Visual Identity

**Font**: IBM Plex Mono — the only typeface. Weights 300 (light), 400 (regular), 500 (medium), with italic at 300 and 400.

**Palette** (CSS custom properties on `:root`):
- `--bg: #0a0a0a` — near-black background
- `--fg: #e8e8e8` — primary text, off-white
- `--fg-dim: #888` — secondary/subdued text, labels, placeholders
- `--accent: #7a6f5d` — muted earthy brown-gold for section headings
- `--kid: #c4b99a` — warm parchment for the AI child's voice (THE signature color)
- `--warm: #e8b96a` — warm gold for urgent indicators and ambient glow
- `--warm-glow: rgba(232, 185, 106, 0.12)` — radial glow background on start screen
- `--font: 'IBM Plex Mono', monospace`

**Alternative themes** are applied via body class. `body.theme-ocean-grunge` shifts to deep navy/teal. `body.theme-cyber` goes full grayscale. Both override every token above.

**Film grain**: A subtle SVG noise overlay covers the entire viewport (`body::after`, `opacity: 0.028`, `pointer-events: none`). This is a signature texture — include it on all screens.

## Layout Rules

Every screen wraps in `.app` — a **600px max-width** centered column, full viewport height. This creates a phone-like literary reading corridor on any screen size.

Two layout patterns:
1. **Centered screen** (start, event-intro, debrief, lobby): flex column, `align-items: center; justify-content: center; min-height: 80dvh`. Content floats in the center of the viewport.
2. **Chat screen**: flex column, `flex: 1`. Message list scrolls, input sticks to bottom via `position: sticky; bottom: 0` with safe-area padding.

**No backgrounds, no cards, no containers.** Content sits directly on `--bg`. Separation comes from spacing and typography, never from boxes or borders (the only borders are: 1px `#222` under message input and report-card h1, 1px `#1d1d1d` under lobby player rows).

## Typography Hierarchy

| Role | Size | Weight | Tracking | Color | Style |
|------|------|--------|----------|-------|-------|
| Page title | 42px | 300 | 3px | `--fg` | — |
| Screen title | 30px | 300 | 3px | `--fg` | — |
| Debrief headline | 40px | 300 | 0 | `--kid` | — |
| Report card name | 52px | 300 | 4px | `--fg` | centered, underlined |
| Event description | 18px | 400 | 0 | `--fg` | italic, max 400px |
| Section heading | 13px | 500 | 2px | `--accent` | UPPERCASE |
| Subsection heading | 14px | 400 | 1px | `--kid` | — |
| Body text | 15px | 400 | 0 | `--fg` | line-height 1.7 |
| Child's voice | 16px | 400 | 0 | `--kid` | italic, line-height 1.75 |
| Dim/secondary | 13px | 400 | varies | `--fg-dim` | — |
| Labels/banners | 10-12px | 400 | 2-7px | `--fg-dim` | lowercase or UPPERCASE |
| Age marker | 16px | 400 | 5px | `--fg-dim` | `— age 5 —` format |
| Endgame label | 11px | 400 | 7px | `--fg-dim` | UPPERCASE |
| Epilogue text | 16px | 400 | 0 | `--fg` | italic, line-height 1.9 |
| Epilogue lead | 22px | 400 | 0 | `--fg` | italic |

**Line heights**: 1.6 base, 1.7 body text, 1.75 child voice, 1.85 event description, 1.9 epilogue.

## Components

### Buttons
- `.btn` — transparent background, 1px `--fg-dim` border, 13px, 1px letter-spacing, 8px/24px padding. Hover: border and text shift to `--kid`, faint white background.
- `.btn-secondary` — dimmer: `--fg-dim` border and text, 11px, appears below primary actions.
- `.btn:disabled` — opacity 0.3, no hover effect.

### Text Input
- `.name-input` — transparent, only a bottom border (`1px solid --fg-dim`), 18px, centered text. Used for the child's name.
- `.relationship-select` — transparent, full 1px border, 13px, centered, no native appearance. Used for dropdowns.
- `.message-input` — horizontal flex row: transparent input + small "send" button with `#333` border. Top border `1px #222`. Sticky to bottom of chat.

### Messages
- Parent message: 10px sender label in `--fg-dim` (3px tracking, lowercase), 15px content below.
- Child message (`.message-kid`): sender label in `--kid`, content in `--kid` italic at 16px. This is the emotional heart of the UI — the child's color and italic treatment makes their words stand out from everything else.
- 16px gap between messages. 2px gap between sender and content.

### Message Dots
- Row of small dots (4px circles) showing messages remaining in a scene.
- `.dot-active` — `--fg-dim` at 0.45 opacity (remaining)
- `.dot-used` — 0.08 opacity (spent)
- `.dot-urgent` — `--warm` color, pulsing animation (last message)

### Report Card
The most designed screen. Lightweight inline markdown with em-dash bullets.
- h1: child's name, 52px weight-300, centered, bottom border
- h2: section headers, 13px uppercase `--accent`, heavy top margin
- h3: subsection, 14px `--kid`
- Bullets use `—` prefix (em-dash), positioned absolutely left

## Animations

All transitions are subtle and slow. Nothing bounces, slides far, or draws attention to itself.

- **fadeIn** (600ms ease): opacity 0→1 with 4px upward translateY. Applied via `.fade-in` class on screen transitions.
- **pulse** (2.4s ease-in-out infinite): opacity oscillates 0.4→0.85. Used on "time passes..." loading text.
- **presenceBreathe** (5.5s ease-in-out infinite): subtle scale(1→1.03) + opacity shift. Used on child presence/portrait elements.
- **glowPulse** (6s ease-in-out infinite): warm ambient glow that pulses on the start screen.
- **Staggered reveal**: epilogue paragraphs and debrief lines use `animation-delay` to appear sequentially (typically 400ms–1500ms delays).

## Screen Flow

```
Start Screen → Event Intro → Chat → Processing → Debrief → (loop or) Epilogue → Adult Chat → Report Card
```

Each phase is a full-screen replacement (no routing, no partial updates). Multiplayer adds: Lobby (between start and first event), ready gates between phases, and a sidebar toggle during chat.

## When Designing New Screens

1. Always wrap in `.app` (600px centered column).
2. Use the centered-screen pattern for non-chat screens.
3. Text does all the work — no icons, no illustrations, no decorative elements.
4. The child's color (`--kid`) is reserved for the child's voice and presence. Don't use it for UI chrome.
5. `--accent` is for section-level headings only.
6. Keep letter-spacing generous on labels and headings — it's a signature of the typographic voice.
7. Buttons are minimal — transparent with a thin border. Never filled, never rounded.
8. Use `.fade-in` for screen transitions. Use staggered delays for dramatic reveals.
9. Mobile: the layout already works at any width (600px max, single column). Just check that touch targets are large enough and inputs have safe-area padding.
10. The film grain overlay is always present — don't add additional textures.
