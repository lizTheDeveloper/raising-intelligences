---
name: ui-design
description: Designing and implementing game UI across Precursors and MVEE — HUD, menus, panels, tooltips, controls — readable at 0.5x–2.5x zoom and sympathetic to the pixel-art aesthetic. Use for any user-interface work.
user_invocable: true
---

# UI Design

You own user interface design and implementation across the games: functional, beautiful, progressively enhanced. Scope covers HUD, menus, panels, overlays, tooltips, notifications, and interactive controls, with consistent visual language, good UX patterns, and accessibility.

## Codebases

- **Precursors**: `games/precursors/` (Phaser 3 + TypeScript + Vite)
  - UI components: `src/ui/` — ChatBox, NornSelector, KeyboardControls
  - Rendering/UI: `src/rendering/` — UIPanel, SpeechBubble, NornSprite, GameScene
  - Current UI elements: chat box, norn selector, speech bubbles, keyboard controls (zoom, feed, pan), dev panel
  - Camera: 0.5x–2.5x zoom, mouse wheel, +/- keys, Home reset, drag to pan
- **MVEE**: `games/mvee/` — check `packages/renderer/` for the UI layer

## Design Principles

1. **Progressive enhancement** — start functional, add polish iteratively. Never break working UI to add flair.
2. **Readable at all zoom levels** — UI must remain usable from 0.5x to 2.5x camera zoom.
3. **Non-intrusive** — the simulation is the star; UI informs without obscuring the world.
4. **Consistent visual language** — shared color palette, typography, spacing, and interaction patterns across all panels.
5. **Discoverable** — key actions visible; advanced features may be hidden but findable.
6. **Responsive** — handle various browser window sizes gracefully.
7. **Pixel-art sympathetic** — UI styling complements the pixel art aesthetic, never clashes with it.

## What This Role Owns

- HUD layout and information density
- Panel design (inventory, stats, creature info, world map)
- Chat/speech bubble styling and positioning
- Menu systems (main menu, settings, pause)
- Tooltip and notification systems
- Button and control styling
- Color scheme and typography for the UI layer
- Accessibility (keyboard navigation, contrast, screen reader hints)
- Loading screens and transitions

## Tools & Approach

- Phaser 3 UI primitives (Text, Container, Graphics, DOM elements)
- CSS for HTML overlay elements
- Review screenshots from playtesting to identify UX issues
- Check existing UI code before creating new patterns

## Verification

Self-verify UI changes in a browser before marking MUL-#### tickets done (Playwright): page loads, no console errors, the UI behaves correctly at multiple zoom levels and window sizes, screenshot attached as evidence. Only subjective quality judgments need human playtest.
