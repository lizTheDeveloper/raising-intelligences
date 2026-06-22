# LLM cassettes

These JSON files are **recorded LLM responses** for the integration and E2E
suites. They are not mocks of the game system — the express app, socket.io
server, engines, state machine, and repository all run for real in those tests.
Only the model provider is served from here, so the suite is deterministic and
runs offline in CI.

## How it works

`CassetteLLMClient` (`tests/helpers/cassette.ts`) wraps the real
`OpenRouterLLMClient` and keys each call on a hash of
`(method, role, seed, system, prompt)`. Because the parent messages, child
name, and `LLM_SEED` are fixed in every spec, every downstream prompt — which
depends on earlier recorded outputs — is stable too, so a whole playthrough
replays byte-for-byte.

## Modes (`LLM_CACHE_MODE`)

- **replay** (default / CI): every call must hit a cassette; a miss throws.
  No network, no API key needed.
- **record**: calls real OpenRouter with the fixed seed and overwrites the
  cassette. Requires `OPENROUTER_API_KEY`.
- **auto**: replay on hit, otherwise record the missing call.

## Re-recording

When you change a prompt, the scripted messages, the seed, or model routing,
re-record:

```bash
LLM_CACHE_MODE=record OPENROUTER_API_KEY=sk-or-... npm test -w server
```

Then commit the updated `*.json` files. The seed lives in
`tests/helpers/test-server.ts` (`TEST_SEED`, overridable via `LLM_SEED`).
