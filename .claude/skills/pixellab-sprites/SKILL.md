---
name: pixellab-sprites
description: Generate pixel art sprites using PixelLab API — characters, tiles, animations, map objects. Covers quality process, directional consistency, and credit management.
user_invocable: true
---

# PixelLab Sprite Generation

Use this skill when creating or modifying pixel art assets for any Multiverse Games project.

## API Access

- **Base URL:** `https://api.pixellab.ai/v1`
- **Auth:** `Authorization: Bearer $PIXELLAB_API_KEY`
- **Credits:** Monthly quota (~7,000 generations). The balance page shows $0.00 USD — this is normal, NOT out of credits.

## MCP Tools

### Characters
| Tool | Purpose |
|------|---------|
| `mcp__pixellab__create_character` | Character sprites with directional views |
| `mcp__pixellab__animate_character` | Walk, idle, attack animations |
| `mcp__pixellab__get_character` / `list_characters` | View existing |
| `mcp__pixellab__delete_character` | Remove character |

### Tiles & Objects
| Tool | Purpose |
|------|---------|
| `mcp__pixellab__create_isometric_tile` | Isometric perspective |
| `mcp__pixellab__create_topdown_tileset` | Top-down map tiles |
| `mcp__pixellab__create_sidescroller_tileset` | Platformer tiles |
| `mcp__pixellab__create_tiles_pro` | Advanced generation |
| `mcp__pixellab__create_map_object` | Trees, rocks, buildings |

All create operations return job IDs. Poll with `get_*` for completion.

## Quality Process

1. **Reference existing sprites first** — Check the sprites folder for style consistency
2. **One generation at a time** — Verify visually before proceeding. Batch scripts waste credits on bad output.
3. **Descriptive prompts** — Include art style, color palette, size, character details
4. **8-direction consistency** — Characters need N, NE, E, SE, S, SW, W, NW views
5. **Animation consistency** — Frames must match base character style (4-8 frames per action)
6. **Save with metadata** — Include metadata.json alongside sprite files

## Style Guidelines

- **Size:** 32x32 or 64x64 base
- **Palettes:** Consistent across related entities
- **Silhouettes:** Clear and readable at game zoom levels
- **Animations:** 4-8 frames, smooth transitions

## Output Locations

| Game | Sprite Path |
|------|------------|
| MVEE | `games/mvee/packages/renderer/assets/sprites/pixellab/` |
| Precursors | `games/precursors/public/sprites/` |

## Parallel Generation Strategy

Use separate Sonnet subagents with different API tokens to generate, iterate, and refine multiple options simultaneously. Select the best results.
