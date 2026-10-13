# Client-side third-party frame guard (MUL-13)

Extensions and iOS Safari content blockers inject scripts into the game page
and their throws get captured by our `window.onerror` wiring as if they were
ours — the `message.response` TypeError @ `webkit-masked-url://hidden/`
(ai_village #98), `contentScriptData.init_ts`, `Can't find variable:
__gCrWeb`, `Invalid call to runtime.sendMessage(). Tab not found.`,
`Response was undefined` family. Closing one GlitchTip issue with `noise`
teaches the pipeline one fingerprint in one repo (`ops/glitchtip-defects`),
so the client drops the whole class at the source instead.

## Rule (`client/src/errorNoise.ts`, used in `main.tsx` beforeSend)

Drop an event iff **every** frame of **every** exception has a filename that
is opaque (`webkit-masked-url://…`, `about:…`, `data:…`, `user-script:…`,
missing) or hosted outside the page origin and outside studio domains
(`*.multiversegames.ai`, `*.multiversestudios.xyz`, `*.themultiverse.school`).
Kept: any event with ≥1 same-origin or studio-host frame, mixed stacks,
frame-less events (conservative — the guard may swallow noise, never a real
defect), relative/build-tool paths, same-origin `blob:`. The pre-existing
network/abort message filter from 8c2571ba and server tier-2/tier-3 rules are
untouched.

## Tests

```
npm run test -w client   # node --import tsx --test tests/errorNoise.test.ts
```

Fixtures: own bundled frame → kept; only `webkit-masked-url://hidden/` →
dropped; mixed → kept; plus extension schemes, `blob:` attribution, no-stack
conservatism.
