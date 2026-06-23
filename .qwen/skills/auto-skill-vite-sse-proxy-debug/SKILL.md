---
name: vite-sse-proxy-debug
description: Debug SSE/WebSocket streaming that works via direct API but fails through Vite dev proxy
source: auto-skill
extracted_at: '2026-06-23T07:15:00.000Z'
---

# Debugging Vite Proxy SSE/WebSocket Issues

When SSE or WebSocket connections work via direct API calls (curl/fetch to backend port) but hang or fail through the Vite dev server, follow this diagnostic procedure.

## Symptoms

- `curl http://localhost:<backend-port>/api/stream` returns streaming data correctly
- `curl http://localhost:<vite-port>/api/stream` hangs with no data
- Browser fetch() to `/api/stream` (through Vite proxy) never receives chunks or completes
- Browser fetch() to `http://localhost:<backend-port>/api/stream` (direct) works fine

## Diagnostic Steps

### Step 1: Confirm the backend works directly

```bash
# Test with curl, streaming output
curl -N http://localhost:3000/api/stream

# If it streams data, the backend is fine
```

### Step 2: Test fetch from browser context

Open browser devtools console and test both paths:

```javascript
// Direct to backend (bypasses Vite proxy)
const direct = await fetch("http://localhost:3000/api/stream", { method: "POST" });
const reader1 = direct.body.getReader();
const { value } = await reader1.read();
console.log("Direct:", new TextDecoder().decode(value));

// Through Vite proxy
const proxy = await fetch("/api/stream", { method: "POST" });
const reader2 = proxy.body.getReader();
const { value: val2 } = await reader2.read();
console.log("Proxy:", new TextDecoder().decode(val2));
```

If direct works but proxy hangs, the issue is the Vite proxy configuration.

### Step 3: Check Vite proxy configuration

Look at `vite.config.ts`:

```javascript
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // Missing: SSE/WS specific config
      }
    }
  }
});
```

### Step 4: Add SSE/WebSocket support to proxy

For **SSE (Server-Sent Events)**:

```javascript
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // Critical for SSE: http-proxy buffers by default
        // These options prevent buffering
        configure: (proxy, options) => {
          proxy.on('proxyRes', (proxyRes, req, res) => {
            // Check if response is SSE
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              // Disable buffering for SSE responses
              res.flushHeaders();
            }
          });
        },
        // Or use raw SSE endpoint with proper headers
        headers: {
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        }
      }
    }
  }
});
```

For **WebSocket**:

```javascript
export default defineConfig({
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,  // Enable WebSocket proxying
        changeOrigin: true
      }
    }
  }
});
```

### Step 5: Alternative - Use separate dev server for API

If proxy configuration is problematic, run the backend on a separate port and have the frontend call it directly:

```javascript
// frontend code
const API_URL = import.meta.env.DEV 
  ? 'http://localhost:3000'  // Direct to backend in dev
  : '/api';                  // Use relative path in production

fetch(`${API_URL}/endpoint`, { ... });
```

## Common Root Causes

1. **http-proxy buffers responses by default** - SSE chunks are held until the connection closes
2. **Missing `flushHeaders()`** - Headers (including `Transfer-Encoding: chunked`) aren't sent immediately
3. **Wrong Content-Type** - Backend sends `application/octet-stream` instead of `text/event-stream`
4. **WebSocket not enabled** - Vite proxy needs `ws: true` for WebSocket upgrades
5. **Compression middleware** - gzip/brotli compresses SSE responses, breaking streaming

## Verification

After applying fixes:

```bash
# Should stream immediately, not buffer
curl -N http://localhost:5173/api/stream

# Browser console should receive chunks in real-time
fetch("/api/stream").then(r => r.body.getReader().read())
  .then(({ value }) => console.log("Got chunk:", value));
```

## Related Files

- `vite.config.ts` or `vite.config.js` - Proxy configuration
- Backend route handlers - Ensure proper SSE headers are set
- Frontend fetch calls - Verify they're using the right URL pattern
