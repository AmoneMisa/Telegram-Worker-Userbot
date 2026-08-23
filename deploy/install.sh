#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tg-worker}"
BRANCH="${BRANCH:-master}"
REPO="${REPO:-https://github.com/AmoneMisa/Telegram-Worker-Userbot.git}"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
for bin in git docker curl; do command -v "$bin" >/dev/null 2>&1 || die "$bin is not installed"; done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

if [ -d "$APP_DIR/.git" ]; then
  log "reusing existing checkout at $APP_DIR"
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ] && [ -f worker.env ]; then
  mv worker.env .env
  log "migrated worker.env to .env"
fi
if [ ! -f .env ]; then
  cp sample.env .env
  log "created $APP_DIR/.env"
fi
chmod 600 .env
mkdir -p photo-cache
chown 1000:1000 .env photo-cache

if grep -Eq '^[[:space:]]*TG_SESSION[[:space:]]*=[[:space:]]*[^[:space:]]' .env; then
  docker compose up -d --build
  log "tg-worker started"
  exit 0
fi

cat <<MSG

[install] Telegram login is still required:
  cd $APP_DIR
  docker compose build
  docker compose run --rm tg-worker npm run login
  docker compose up -d

The login writes credentials and TG_SESSION into .env.
MSG
