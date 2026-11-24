#!/bin/bash
set -e

REPO_DIR="/opt/raising-intelligences/repo"
DEPLOY_DIR="/opt/raising-intelligences"

echo "[deploy] pulling latest..."
cd "$REPO_DIR"
git pull origin main

echo "[deploy] building image (tests run inside Docker build)..."
# Vite inlines import.meta.env at BUILD time, so the GlitchTip DSN has to be a
# --build-arg. Passing it only as a runtime --env-file (below) arrives too late
# and Vite tree-shakes the Sentry init out entirely.
VITE_SENTRY_DSN_VALUE="$(grep -E "^SENTRY_DSN=" "$DEPLOY_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -z "$VITE_SENTRY_DSN_VALUE" ]; then
  echo "[deploy] WARNING: SENTRY_DSN not found in .env — browser errors will NOT be reported"
fi

# Sourcemap upload token for GlitchTip release artifacts. Lives in the
# glitchtip-defects env, not this app's .env. Passed to the build as a
# BuildKit secret (never a --build-arg/ENV) so it can't leak into an image
# layer or `docker history`. Written to a chmod-600 tempfile that's removed
# on exit no matter how the script terminates.
GLITCHTIP_TOKEN_FILE="/opt/glitchtip-defects/.env"
GLITCHTIP_TOKEN_VALUE="$(grep -E "^GLITCHTIP_TOKEN=" "$GLITCHTIP_TOKEN_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "\r\n')"
VITE_SENTRY_RELEASE="$(git -C "$REPO_DIR" rev-parse --short HEAD)"

SENTRY_TOKEN_TMPFILE=""
cleanup() {
  if [ -n "$SENTRY_TOKEN_TMPFILE" ] && [ -f "$SENTRY_TOKEN_TMPFILE" ]; then
    rm -f "$SENTRY_TOKEN_TMPFILE"
  fi
}
trap cleanup EXIT

SECRET_ARGS=()
if [ -z "$GLITCHTIP_TOKEN_VALUE" ]; then
  echo "[deploy] WARNING: GLITCHTIP_TOKEN not found in $GLITCHTIP_TOKEN_FILE — sourcemaps will NOT be uploaded (build continues without upload)"
else
  SENTRY_TOKEN_TMPFILE="$(mktemp)"
  chmod 600 "$SENTRY_TOKEN_TMPFILE"
  printf '%s' "$GLITCHTIP_TOKEN_VALUE" > "$SENTRY_TOKEN_TMPFILE"
  SECRET_ARGS=(--secret "id=sentry_auth_token,src=$SENTRY_TOKEN_TMPFILE")
fi

DOCKER_BUILDKIT=1 docker build -f "$REPO_DIR/Dockerfile" \
  --build-arg "VITE_SENTRY_DSN=$VITE_SENTRY_DSN_VALUE" \
  --build-arg "VITE_SENTRY_RELEASE=$VITE_SENTRY_RELEASE" \
  "${SECRET_ARGS[@]}" \
  -t raising-intelligences:latest "$REPO_DIR"

echo "[deploy] stopping old container..."
docker stop raising-intelligences 2>/dev/null || true
# Keep every byte of the old container's log: `docker rm` deletes it, and RI's
# logs are never to be lost (Liz, 2026-11-24). The log is gzipped into
# /var/log/raising-intelligences on the host first. If that fails, the old
# container is renamed rather than removed, so its log is still on disk.
#
# This script runs inside the ri-webhook container, which cannot see the host's
# /var/lib/docker or /var/log, so the copy runs in a throwaway container started
# through the host's docker socket: its -v paths are host paths. It also works
# when the script is run on the host by hand.
RI_LOG_ARCHIVE=/var/log/raising-intelligences
keep_old_container() {
  echo "[deploy] WARNING: $1; keeping the old container as raising-intelligences-$STAMP" >&2
  if ! docker rename raising-intelligences "raising-intelligences-$STAMP"; then
    # Neither archived nor renamed: put the old container back and stop here,
    # rather than lose its log or leave the site down.
    echo "[deploy] ERROR: could not rename the old container either; restarting it and aborting this deploy" >&2
    docker start raising-intelligences >/dev/null || true
    exit 1
  fi
}
if docker inspect raising-intelligences >/dev/null 2>&1; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  ARCHIVE="container-$STAMP.json.log.gz"
  OLD_LOG="$(docker inspect --format '{{.LogPath}}' raising-intelligences 2>/dev/null || true)"
  # RI logs hold player text: the folder is root-only (0700) and each archive is
  # 0600. The archive is written as .part, gzip-tested, its unpacked size checked
  # against the log's, and only then renamed into place.
  if [ -n "$OLD_LOG" ] && docker run --rm --user 0:0 --network none --entrypoint sh \
       -v "$(dirname "$OLD_LOG"):/in:ro" -v "$RI_LOG_ARCHIVE:/out" \
       raising-intelligences:latest -c '
         set -e
         chmod 0700 /out
         umask 077
         test -f "/in/$1"
         gzip -c "/in/$1" > "/out/$2.part"
         gzip -t "/out/$2.part"
         test "$(gzip -dc "/out/$2.part" | wc -c)" -eq "$(wc -c < "/in/$1")"
         mv "/out/$2.part" "/out/$2"' sh "$(basename "$OLD_LOG")" "$ARCHIVE"; then
    echo "[deploy] archived old container log to $RI_LOG_ARCHIVE/$ARCHIVE"
    docker rm raising-intelligences >/dev/null || keep_old_container "could not remove the old container"
  else
    keep_old_container "could not archive the old log"
  fi
fi

echo "[deploy] starting new container..."
docker run -d \
  --name raising-intelligences \
  --restart unless-stopped \
  --network coolify \
  --env-file "$DEPLOY_DIR/.env" \
  --volume /opt/raising-intelligences/portraits:/app/portraits \
  --health-cmd 'node -e "require(\"http\").get(\"http://localhost:3000/health\", r => process.exit(r.statusCode === 200 ? 0 : 1)).on(\"error\", () => process.exit(1))"' \
  --health-interval 30s \
  --health-timeout 10s \
  --health-retries 3 \
  --health-start-period 30s \
  --label 'traefik.enable=true' \
  --label 'traefik.http.routers.ri.rule=Host(`multiversegames.ai`)' \
  --label 'traefik.http.routers.ri.entrypoints=https' \
  --label 'traefik.http.routers.ri.tls.certresolver=letsencrypt' \
  --label 'traefik.http.routers.ri-http.rule=Host(`multiversegames.ai`)' \
  --label 'traefik.http.routers.ri-http.entrypoints=http' \
  --label 'traefik.http.routers.ri-http.middlewares=ri-https-redirect' \
  --label 'traefik.http.middlewares.ri-https-redirect.redirectscheme.scheme=https' \
  --label 'traefik.http.middlewares.ri-https-redirect.redirectscheme.permanent=true' \
  --label 'traefik.http.services.ri.loadbalancer.server.port=3000' \
  raising-intelligences:latest

echo "[deploy] waiting for health check..."
sleep 15
STATUS=$(docker inspect raising-intelligences --format '{{.State.Health.Status}}' 2>/dev/null || echo 'no-healthcheck')
echo "[deploy] health: $STATUS"
echo "[deploy] built release: $VITE_SENTRY_RELEASE"
echo "[deploy] done."
