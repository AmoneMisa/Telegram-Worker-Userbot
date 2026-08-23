#!/usr/bin/env bash
# Deploy the worker with Docker Compose and verify /health. If the new revision
# is unhealthy, rebuild and restore the previous revision automatically.

set -euo pipefail

if [ -z "${DEPLOY_REEXEC:-}" ] && [ -f "$0" ]; then
  self_copy="$(mktemp)"
  cat "$0" > "$self_copy"
  DEPLOY_REEXEC=1 exec bash "$self_copy" "$@"
elif [ -n "${DEPLOY_REEXEC:-}" ]; then
  trap 'rm -f "$0"' EXIT
fi

APP_DIR="${APP_DIR:-/opt/tg-worker}"
BRANCH="${BRANCH:-master}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout — run deploy/install.sh first"
command -v git >/dev/null 2>&1 || die "git is required"
command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
command -v curl >/dev/null 2>&1 || die "curl is required for the health check"
cd "$APP_DIR"

# One-time migration from the previous systemd deployment.
if [ ! -f .env ] && [ -f worker.env ]; then
  mv worker.env .env
  log "migrated worker.env to .env"
fi
[ -f .env ] || die ".env is missing — copy sample.env to .env and configure Telegram credentials"
chmod 600 .env
mkdir -p photo-cache
if [ "$(id -u)" -eq 0 ]; then
  chown 1000:1000 .env photo-cache
fi

# Do not let the old Node/systemd process compete with Docker for port 4100.
if command -v systemctl >/dev/null 2>&1 && systemctl cat tg-worker >/dev/null 2>&1; then
  if systemctl is-active --quiet tg-worker; then
    log "stopping old tg-worker systemd service"
    systemctl stop tg-worker
  fi
  systemctl disable tg-worker >/dev/null 2>&1 || true
fi

port_from_env() {
  local p
  p="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p' .env | tail -n1)"
  echo "${p:-4100}"
}
PORT="$(port_from_env)"

check_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" | grep -q '"ok":true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

start_revision() {
  docker compose build --pull
  docker compose up -d --remove-orphans
}

PREV="$(git rev-parse HEAD)"
log "current revision $PREV"
log "fetching origin/$BRANCH"
git fetch --prune origin "$BRANCH"
TARGET="$(git rev-parse "origin/$BRANCH")"

if [ "$TARGET" = "$PREV" ] && [ "${FORCE:-}" != "1" ]; then
  if docker compose ps --status running --services | grep -qx 'tg-worker' && check_health; then
    log "already at $TARGET and healthy — nothing to do"
    exit 0
  fi
fi

git reset --hard "$TARGET"
log "checked out $TARGET"
start_revision

if check_health; then
  log "healthy on :$PORT — deployed $TARGET"
  exit 0
fi

log "health check failed; rolling back to $PREV"
docker compose logs --tail=60 tg-worker || true
git reset --hard "$PREV"
start_revision
if check_health; then
  log "rolled back to $PREV and healthy again"
else
  docker compose logs --tail=100 tg-worker || true
  die "rollback did not become healthy"
fi
die "deploy of $TARGET failed health check"
