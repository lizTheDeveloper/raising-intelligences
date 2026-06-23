---
name: traefik-subpath-debug
description: Debugging production 502 errors and routing issues for apps deployed under subpaths with Traefik
source: auto-skill
extracted_at: '2026-06-23T06:13:38.646Z'
---

# Debugging Traefik Subpath Routing in Production

When an app is deployed under a subpath (e.g., `/raising-intelligences/`) behind Traefik with `stripPrefix` middleware, various routing issues can cause 502 errors or 404s.

## Common Issues

### 1. Static Assets Not Being Served
**Symptom**: Client requests for static files (images, portraits, uploads) return 502
**Root Cause**: Traefik strips the subpath prefix, but the app's static file routes don't account for this
**Solution**: Check if the app has internal routes that bypass the strip middleware

### 2. Environment Variables Not Set in Production
**Symptom**: Features that depend on external APIs fail silently or throw generic errors
**Root Cause**: Required env vars (like `OPENAI_API_KEY`) not added to production `.env` file
**Diagnosis**: 
```bash
# Check container's env vars
ssh <server> "docker exec <container> env | grep -E 'KEY|SECRET|API'"

# Check app logs for missing key warnings
ssh <server> "docker logs <container> 2>&1 | grep -i 'not set\|missing\|skipped'"
```

### 3. Socket.IO Connection Failures
**Symptom**: Real-time features (multiplayer, live updates) don't work
**Root Cause**: Socket.IO router needs higher priority and must bypass strip middleware
**Solution**: Add dedicated router in Traefik config:

```yaml
# Higher priority router for socket.io that does NOT use strip middleware
- rule: "PathPrefix(`/raising-intelligences/socket.io`)"
  service: raising-intelligences@file
  entryPoints:
    - web
  priority: 10  # Higher than the catch-all subpath router

# Lower priority catch-all for everything else
- rule: "PathPrefix(`/raising-intelligences`)"
  middlewares:
    - strip-raising-intelligences
  service: raising-intelligences@file
  entryPoints:
    - web
  priority: 1
```

## Debugging Checklist

1. **Check app health internally** (bypasses Traefik):
   ```bash
   ssh <server> "docker exec <container> curl -s http://localhost:3000/api/health"
   ```

2. **Check container logs for errors**:
   ```bash
   ssh <server> "docker logs <container> --tail 50 2>&1 | grep -i 'error\|warn\|fail'"
   ```

3. **Check Traefik logs for routing issues**:
   ```bash
   ssh <server> "docker logs traefik --tail 50 2>&1 | grep -i '502\|404\|raising-intelligences'"
   ```

4. **Test the failing endpoint directly from inside container**:
   ```bash
   ssh <server> "docker exec <container> curl -I http://localhost:3000/<path-that-fails>"
   ```

5. **Verify env vars are set**:
   ```bash
   ssh <server> "docker exec <container> env | grep REQUIRED_VAR"
   ```

## Key Insight

When troubleshooting 502 errors through Traefik:
- First verify the app itself is healthy internally (inside the container)
- Then check if Traefik is correctly routing to it
- Finally check if middleware (strip, headers, etc.) is interfering

The error is almost always one of:
- App crashed or can't start (bad config, missing env vars)
- Traefik routing misconfigured (wrong service name, middleware stripping too much)
- Static files not generated (missing API keys, failed generation)
