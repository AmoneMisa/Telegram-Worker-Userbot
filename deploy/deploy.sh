#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tg-worker}"
BRANCH="${BRANCH:-master}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout"
command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
cd "$APP_DIR"

if [ ! -f .env ] && [ -f worker.env ]; then
  mv worker.env .env
  log "migrated worker.env to .env"
fi
[ -f .env ] || die ".env is missing"
chmod 600 .env
mkdir -p photo-cache
if [ "$(id -u)" -eq 0 ]; then chown 1000:1000 .env photo-cache; fi

if command -v systemctl >/dev/null 2>&1 && systemctl cat tg-worker >/dev/null 2>&1; then
  systemctl stop tg-worker >/dev/null 2>&1 || true
  systemctl disable tg-worker >/dev/null 2>&1 || true
fi

PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p' .env | tail -n1)"
PORT="${PORT:-4100}"

check_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" | grep -q '"ok":true'; then return 0; fi
    sleep 2
  done
  return 1
}

start_revision() {
  docker compose build --pull
  docker compose up -d --remove-orphans
}

PREV="$(git rev-parse HEAD)"
git fetch --prune origin "$BRANCH"
TARGET="$(git rev-parse "origin/$BRANCH")"
git reset --hard "$TARGET"
start_revision

if check_health; then
  log "healthy on :$PORT — deployed $TARGET"
  exit 0
fi

log "health check failed; rolling back to $PREV"
docker compose logs --tail=60 tg-worker || true
git reset --hard "$PREV"
start_revision
check_health || { docker compose logs --tail=100 tg-worker || true; die "rollback did not become healthy"; }
die "deploy of $TARGET failed health check"
