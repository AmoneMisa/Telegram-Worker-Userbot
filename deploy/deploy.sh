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

container_health() {
  docker compose exec -T tg-worker node -e \
    "fetch('http://127.0.0.1:4100/health').then(async r => { const b = await r.json(); if (!r.ok || b.ok !== true) process.exit(1) }).catch(() => process.exit(1))" \
    >/dev/null 2>&1
}

check_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if container_health && \
       curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" | grep -q '"ok":true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

start_revision() {
  local compose_file="${1:-compose.yml}"
  docker compose -f "$compose_file" --project-directory "$APP_DIR" build --pull
  docker compose -f "$compose_file" --project-directory "$APP_DIR" up -d --remove-orphans
}

PREV="$(git rev-parse HEAD)"
git fetch --prune origin "$BRANCH"
TARGET="$(git rev-parse "origin/$BRANCH")"
git reset --hard "$TARGET"

[ -f compose.yml ] || die "target revision $TARGET has no compose.yml"
ROLLBACK_COMPOSE="$(mktemp --suffix=.yml)"
cp compose.yml "$ROLLBACK_COMPOSE"
trap 'rm -f "$ROLLBACK_COMPOSE"' EXIT

start_revision compose.yml

if check_health; then
  log "healthy on :$PORT — deployed $TARGET"
  exit 0
fi

log "health check failed; rolling back to $PREV"
docker compose logs --tail=60 tg-worker || true

git reset --hard "$PREV"
# PREV may predate Compose. Reuse the deployment manifest from TARGET while
# rebuilding its build context from PREV, so rollback remains containerized and
# does not depend on the host Node/npm version.
start_revision "$ROLLBACK_COMPOSE"

if check_health; then
  log "rolled back to $PREV and healthy again"
else
  docker compose -f "$ROLLBACK_COMPOSE" --project-directory "$APP_DIR" logs --tail=100 tg-worker || true
  die "rollback did not become healthy"
fi

die "deploy of $TARGET failed health check"