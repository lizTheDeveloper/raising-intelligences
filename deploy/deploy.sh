#!/bin/bash
set -e

REPO_DIR="/opt/raising-intelligences/repo"
DEPLOY_DIR="/opt/raising-intelligences"

echo "[deploy] pulling latest..."
cd "$REPO_DIR"
git pull origin main

echo "[deploy] running tests..."
npm run test -w server

echo "[deploy] building image..."
cd "$DEPLOY_DIR"
docker compose build --no-cache ri

echo "[deploy] restarting container..."
docker compose up -d --force-recreate ri

echo "[deploy] waiting for health..."
sleep 10
docker inspect raising-intelligences --format '{{.State.Health.Status}}'

echo "[deploy] done."
