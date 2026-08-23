#!/usr/bin/env bash
# Deploy the worker with Docker Compose and verify the container healthcheck.
# If the new revision is unhealthy, rebuild and restore the previous revision.

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

# Health is checked inside the container. The published host address may be a
# public/private interface (TG_BIND_IP), so probing 127.0.0.1 on the host is not
# a reliable indication that the application itself is healthy.
check_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local status
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' tg-worker 2>/dev/null || true)"
    case "$status" in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

start_revision() {
  local compose_file="${1:-compose.yml}"
  docker compose --project-directory "$APP_DIR" -f "$compose_file" build --pull
  docker compose --project-directory "$APP_DIR" -f "$compose_file" up -d --remove-orphans
}

PREV="$(git rev-parse HEAD)"
log "current revision $PREV"
log "fetching origin/$BRANCH"
git fetch --prune origin "$BRANCH"
TARGET="$(git rev-parse "origin/$BRANCH")"

git reset --hard "$TARGET"
log "checked out $TARGET"
[ -f compose.yml ] || die "target revision has no compose.yml"

# Keep the target Compose manifest outside Git so rollback to a pre-Compose
# revision can still rebuild/start the previous application code in Docker.
ROLLBACK_COMPOSE="$APP_DIR/.deploy-compose.rollback.yml"
cp compose.yml "$ROLLBACK_COMPOSE"
trap 'rm -f "$ROLLBACK_COMPOSE"' EXIT

start_revision compose.yml

if check_health; then
  log "container healthy — deployed $TARGET"
  exit 0
fi

log "health check failed; rolling back to $PREV"
docker compose logs --tail=80 tg-worker || true
git reset --hard "$PREV"

# Previous revisions may predate compose.yml; use the preserved manifest while
# building against the rolled-back Dockerfile/source via --project-directory.
start_revision "$ROLLBACK_COMPOSE"
if check_health; then
  log "rolled back to $PREV and healthy again"
else
  docker compose --project-directory "$APP_DIR" -f "$ROLLBACK_COMPOSE" logs --tail=120 tg-worker || true
  die "rollback did not become healthy"
fi

die "deploy of $TARGET failed health check"
