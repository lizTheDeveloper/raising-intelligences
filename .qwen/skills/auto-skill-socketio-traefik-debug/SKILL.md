---
name: socketio-traefik-debug
description: Debugging socket.io connection failures through Traefik — CORS and stripPrefix middleware interactions that silently break WebSocket handshakes
source: auto-skill
extracted_at: '2026-06-23T05:08:24.106Z'
---

# Debugging Socket.IO Through Traefik (or Any Reverse Proxy with Path Stripping)

When socket.io client can't connect and the browser shows `CONNECT_ERROR`, there are typically **two independent issues** that must both be fixed. They are easy to misdiagnose because fixing one reveals the other.

## Common Failure Mode 1: CORS Rejection

**Symptom:** `CONNECT_ERROR: server error` — the request never reaches the backend.

**Root cause:** Socket.io's server-side CORS config rejects the browser's `Origin` header. Unlike Express's `cors()` middleware (which can be configured globally), socket.io has its own CORS config that must explicitly allow the production origin.

**Fix:** Set `ALLOWED_ORIGIN` (or equivalent) env var on the server:

```typescript
// In buildServer():
const io = new SocketServer(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173" },
  path: socketPath,
});
```

Without `ALLOWED_ORIGIN`, the default remains `localhost:5173` which rejects production requests.

**How to verify:** Check that `ALLOWED_ORIGIN=https://yourdomain.com` is in the production `.env`. Then `curl -v` the socket.io endpoint — a 200 with `0{...}` (socket.io envelope with `sid`) means CORS passed; HTML means Express's catch-all intercepted it.

## Common Failure Mode 2: Reverse Proxy strips the path

**Symptom:** `CONNECT_ERROR: xhr poll error` or `404 Not Found` on the socket.io path — the request reaches the server but socket.io doesn't handle it.

**Root cause:** Traefik (or nginx/caddy) uses `stripPrefix` middleware on the `/raising-intelligences/*` route, so a browser request to `/raising-intelligences/socket.io/` gets forwarded to the backend as `/socket.io/`. But the socket.io server is listening at `/raising-intelligences/socket.io` — so the request never matches, and falls through to Express's SPA catch-all which serves `index.html`.

**Debugging approach:**
1. **Test inside the container directly** — if `curl http://localhost:3000/raising-intelligences/socket.io/?EIO=4&transport=polling` returns `0{"sid":...}`, socket.io works internally. This proves the issue is in the proxy layer.
2. **Test through the proxy** — `curl -v https://domain/raising-intelligences/socket.io/?EIO=4&transport=polling`. If you get HTML instead of `0{...}`, the proxy is modifying the path.
3. **Check the middleware** — look at Traefik's `stripPrefix` config (or nginx's `proxy_pass` with a trailing slash path).

**The fix — a dedicated Traefik router WITHOUT stripPrefix:**

```yaml
# In multiversegames-ai.yml (Traefik dynamic config):
mg-ai-ri-socket-io:
  rule: "Host(`multiversegames.ai`) && PathPrefix(`/raising-intelligences/socket.io`)"
  entryPoints: [https]
  service: raising-intelligences@file
  tls:
    certResolver: letsencrypt
  priority: 200    # Higher than the generic /raising-intelligences route (150)
# NO middlewares — socket.io needs the full path, not the stripped one
```

**Why priority matters:** Traefik matches routers by priority (highest first). The socket.io router (priority 200) must match before the generic RI route (priority 150) which has `stripPrefix`.

## The Full Working Architecture

```
Browser → Traefik
  /raising-intelligences/socket.io/*  →  mg-ai-ri-socket-io  →  server:3000/raising-intelligences/socket.io/*  (no strip)
  /raising-intelligences/api/*        →  mg-ai-ri             →  server:3000/api/*                            (ri-strip removes /raising-intelligences)
  /raising-intelligences/*            →  mg-ai-ri             →  server:3000/*                                (ri-strip removes /raising-intelligences)
```

The socket.io path must NOT be stripped because socket.io internally matches requests against its configured `path` option — if the path is stripped, it doesn't recognize the request.

## Quick Diagnostic Checklist

1. Can you `curl` the socket.io polling endpoint **from inside the container** and get `0{"sid":...}`?
   - Yes → server code is fine; problem is in proxy config
   - No → server code bug; check socket.io path initialization
2. Does the response get `text/html` back through the proxy?
   - Yes → proxy is stripping the path and Express's catch-all serves index.html
   - Fix: add a dedicated no-strip router with higher priority
3. Do you get `server error` (not `xhr poll error`)?
   - Yes → CORS is rejecting the `Origin` header
   - Fix: set `ALLOWED_ORIGIN` on the server
4. After fixing Traefik config, remember that:
   - Traefik with `watch: true` reloads dynamic config automatically
   - You still need to **redeploy** the server container if it has stale code
   - The client also must use the matching `path` option in its `io()` call

## Client-Side path Configuration

The client must use the **same** path the server listens on:

```typescript
// Dev (no proxy): path = "/socket.io"
// Prod (behind Traefik): path = "/raising-intelligences/socket.io"
//   (because Traefik's ri-socket-io router doesn't strip the prefix)
const socketPath = import.meta.env.PROD
  ? "/raising-intelligences/socket.io"
  : "/socket.io";
const socket = io({ autoConnect: true, path: socketPath });
```

## Key Insight

The subtle part: **both REST and WebSocket traffic share the same hostname and subpath prefix**, but REST needs path stripping while WebSocket must NOT be stripped**. You can't use a single Traefik router with `stripPrefix` for both — you need two routers with different priorities and different middleware configs.

This pattern applies to any reverse proxy that supports path rewriting — Traefik `stripPrefix`, nginx `proxy_pass` with trailing slashes, Caddy's `uri strip_prefix`, etc. The fix is always the same concept: route the socket.io path specifically without stripping.
