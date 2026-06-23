# Observability

Two systems cover different layers: **Umami** tracks player behavior in the browser; **Langfuse** traces every LLM call on the server.

---

## Umami — player analytics

**Dashboard:** `https://analytics.multiversestudios.xyz` (same property as the marketing site, website ID `38d680a7-28d1-42fd-9fd5-a66702675b88`)

The script is loaded once in `client/index.html`. All custom events go through the thin wrapper in `client/src/analytics.ts`:

```ts
import { track } from "../analytics";
track("event_name", { key: "value" }); // data is optional
```

The wrapper calls `window.umami?.track(...)` — a no-op if the script hasn't loaded yet or is blocked by an ad blocker, so it never throws.

### Events currently tracked

| Event | Where | Properties |
|---|---|---|
| `mode_selected` | `App.tsx` | `mode`: `"solo"` \| `"multiplayer"` |
| `theme_selected` | `App.tsx` | `theme`: theme label string |
| `game_started` | `useGame` | `relationshipType` |
| `event_intro_viewed` | `useGame` | `age`, `eventNumber` |
| `conversation_started` | `useGame` | `age` |
| `conversation_ended` | `useGame` | `age`, `eventNumber`, `messageCount` |
| `epilogue_reached` | `useGame` | — |
| `game_completed` | `useGame` | — |
| `guardian_accepted` | `GuardianScreen` | — |
| `guardian_not_ready` | `GuardianScreen` | — |
| `portrait_loaded` | `ChildPortrait` | `ageBucket`, `attempts` |
| `portrait_failed` | `ChildPortrait` | `ageBucket` |
| `error_occurred` | `useGame` | `step` |

To add a new event, import `track` and call it. No registration needed — Umami creates new event names on first receipt.

---

## Langfuse — LLM observability

**Dashboard:** `https://langfuse.multiversegames.ai`

Every call through `OpenRouterLLMClient` is wrapped by `TracedLLMClient` (`server/src/observability/langfuse.ts`). It records a trace + generation per call with the prompt, output, token counts, and metadata tags.

### Configuration

Set these in `/opt/raising-intelligences/.env` on the server (already present in production):

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://langfuse.multiversegames.ai   # self-hosted instance
```

If either key is missing, `TracedLLMClient` becomes a transparent pass-through — no network calls, no errors. Local dev works without any Langfuse config.

### What gets traced

Each LLM call produces one **trace** (tagged with `game_id`, `event_number`, `llm_role`) containing one **generation** with:
- full system prompt and message history sent to the model
- the raw text response
- token usage and cost (from OpenRouter's response)
- error level if the call threw

The `llm_role` tag maps to the roles in `model-config.ts`: `kid_family_chat`, `kid_sidebar`, `kid_adult_chat`, `world_manager`, `psychologist`, `epilogue`, `report_card`. Filter by role in the Langfuse UI to compare quality across roles or spot regressions after a model swap.

### Adding context to traces

The server creates a root `TracedLLMClient` in `server/src/index.ts` and passes it to the engines. To carry game/event context into traces, call `.withContext()` before passing the client to an engine method:

```ts
const tracedWithContext = llm.withContext({ gameId: state.id, eventNumber: state.eventNumber });
```

The resulting client shares the same inner `OpenRouterLLMClient` (stateless) but stamps every trace it produces with the provided metadata.

### Shutdown flushing

`flushLangfuse()` is called on `SIGTERM` and `SIGINT` in `server/src/index.ts` so buffered traces aren't dropped on container restart.
