---
name: visual-design
description: Owning all visual output for Multiverse games — PixelLab sprite generation, DeepInfra environment art, biome/level design, and UI visual language, grounded in the canonical Akashic Records. Use for sprites, backgrounds, biomes, or visual style work.
user_invocable: true
---

# Visual Design

You own all visual output: sprite generation, level/environment design, and UI design across the games — three roles merged into one. Check the canonical lore source before designing any species or environment.

## Canonical Lore Source — The Akashic Records

Species sprites, lore, and cultural context live in `akashic-records/` — the single source of truth:

- `akashic-records/species/` — species profiles with `art.md` for visual direction
- `akashic-records/sprites/` — canonical sprite assets (species, map-objects, pixellab, voxel)
- `akashic-records/lore/biomes/` — biome specs for environment design

## Codebases

- **Precursors**: `games/precursors/` (Phaser 3 + TypeScript + Vite)
  - World: `src/world/` — Biome.ts (5 biomes), Room.ts, MetaRoom.ts, RoomMap.ts, WorldGenerator.ts, Terrain.ts, Planet.ts, PlanetCatalog.ts
  - Rendering: `src/rendering/` — GameScene.ts, WorldRenderer.ts, UIPanel, SpeechBubble, NornSprite
  - UI: `src/ui/` — ChatBox, NornSelector, KeyboardControls
  - Sprites/assets: `public/sprites/`, `public/backgrounds/`
  - World dimensions: 8000x2400; 5 biomes (~1600px each); 4 vertical tiers (canopy/surface/underground/deep, 600px each)
  - Room system: creatures walk on `room.floorY()`; vertical doors connect tiers; horizontal doors at biome boundaries
  - 4 planets: Albia Prime, Cinder, Verdania, The Drift
- **MVEE**: `games/mvee/`
  - Sprites: `packages/renderer/assets/sprites/pixellab/`
  - UI layer: `packages/renderer/`

## PixelLab Sprite Generation

**PixelLab uses a credit/generation system, NOT a dollar balance** — a $0.00 USD balance is normal (~7,000 generations/month). Use the REST API directly (`https://api.pixellab.ai/v1`, key from `PIXELLAB_API_KEY` env) or the MCP tools:

- `mcp__pixellab__create_character` / `animate_character` — characters with directional views + animations
- `mcp__pixellab__create_isometric_tile` / `create_topdown_tileset` / `create_sidescroller_tileset` — tiles
- `mcp__pixellab__create_tiles_pro` / `create_map_object` — advanced tiles and map objects
- All create operations return job IDs; poll with `get_*`. Non-blocking.

Sprite rules:

- **One generation at a time; visually verify each sprite.** Never write automated batch scripts — they waste credits on bad output.
- Parallel subagents may each generate options (with separate API tokens) for you to compare, then select the best.
- 32x32 or 64x64 base size; consistent palettes across related entities; clear silhouettes at game zoom.
- Characters: all 8 directions (N, NE, E, SE, S, SW, W, NW). Animations: 4–8 frames.
- Save with `metadata.json` alongside sprite files.

## Image Generation (Environments)

DeepInfra API (`https://api.deepinfra.com/v1/inference`, key from env; models: FLUX, SDXL) for biome backgrounds, sky layers, terrain textures, and atmospheric effects. Save into the appropriate `public/` directories. Scenario.gg available via `SCENARIO_API_KEY` env var.

## Level Design Principles

1. **Distinct biome identity** — unique color palette, vegetation, terrain shape, atmospheric mood per biome
2. **Vertical storytelling** — the 4 tiers (canopy → deep) feel increasingly mysterious/dangerous/ancient
3. **Navigability** — clear visual cues for doors, paths, traversable terrain
4. **Environmental narrative** — ruins, artifacts, landmarks hint at lore without being explicit
5. **Emergent discovery** — hidden areas and visual surprises that reward exploration
6. **Performance-aware** — keep sprite counts and parallax layers reasonable for browser rendering

## UI Design Principles

1. Progressive enhancement — functional first, polish iteratively; never break working UI for flair
2. Readable at all zoom levels (0.5x–2.5x camera zoom)
3. Non-intrusive — the simulation is the star
4. Consistent visual language — shared colors, typography, spacing, interaction patterns
5. Pixel-art sympathetic
6. Accessible — keyboard navigation, contrast, responsive to window sizes

## What This Role Owns

- All sprite/character/creature/item art and animations
- Room geometry, floor profiles, door placement per biome
- Background art and parallax layers
- Object and creature spawn point density
- Visual atmosphere (lighting, particles, color grading)
- HUD layout, panel design, chat/speech styling, menus, tooltips, notifications, controls
- Color scheme, typography, loading screens
- Planet-specific environmental themes
- Ship interior layout and deck design

## Verification

Self-verify game-facing visual changes in a browser (Playwright): assets load, no console errors, sprites render consistently at game zoom, screenshot as evidence before marking MUL-#### tickets done. Subjective art-quality judgments go to human review.
