#!/usr/bin/env bash
#
# Deploy the worker in place: fast-forward the checkout to origin/<branch>,
# install production deps, restart the service and verify /health. If the new
# revision fails its health check the previous one is restored automatically.
#
# Used two ways:
#   - by CI, piped over ssh:   ssh host 'bash -s' < deploy/deploy.sh
#   - by hand on the server:   sudo /opt/tg-worker/deploy/deploy.sh
#
# Knobs (env vars):
#   APP_DIR   checkout to deploy         (default /opt/tg-worker)
#   SERVICE   systemd unit to restart    (default tg-worker)
#   BRANCH    branch to deploy           (default master)
#   HEALTH_TIMEOUT  seconds to wait for /health (default 45)

set -euo pipefail

# Running this file from inside the checkout it is about to rewrite would make
# bash read the rest of the script out of a file git just replaced. Re-exec
# from a private copy first. (When piped in over ssh — `bash -s` — there is no
# file to protect and $0 is just "bash", so this is skipped.)
if [ -z "${DEPLOY_REEXEC:-}" ]; then
  if [ -f "$0" ]; then
    self_copy="$(mktemp)"
    cat "$0" > "$self_copy"
    DEPLOY_REEXEC=1 exec bash "$self_copy" "$@"
  fi
else
  trap 'rm -f "$0"' EXIT
fi

APP_DIR="${APP_DIR:-/opt/tg-worker}"
SERVICE="${SERVICE:-tg-worker}"
BRANCH="${BRANCH:-master}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-45}"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# Deploying as a non-root user works as long as it may drive the unit
# (a sudoers rule, or systemctl's polkit prompt-free path).
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout — run deploy/install.sh first"
systemctl cat "$SERVICE" >/dev/null 2>&1 ||
  die "systemd unit '$SERVICE' is not installed — run deploy/install.sh first"
command -v curl >/dev/null 2>&1 || die "curl is required for the health check"
cd "$APP_DIR"

port_from_env() {
  local f="$APP_DIR/worker.env"
  [ -f "$f" ] || { echo 4100; return; }
  local p
  p="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p' "$f" | tail -n1)"
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

PREV="$(git rev-parse HEAD)"
log "current revision $PREV"

log "fetching origin/$BRANCH"
git fetch --prune origin "$BRANCH"
TARGET="$(git rev-parse "origin/$BRANCH")"

if [ "$TARGET" = "$PREV" ] && [ "${FORCE:-}" != "1" ] && systemctl is-active --quiet "$SERVICE"; then
  log "already at $TARGET and the service is running — nothing to do"
  exit 0
fi

# The deploy dir is a deployment target, not a workspace: local edits are
# discarded. worker.env / photo-cache are gitignored, so they survive.
git reset --hard "$TARGET"
log "checked out $TARGET"

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

log "restarting $SERVICE"
$SUDO systemctl restart "$SERVICE"

if check_health; then
  log "healthy on :$PORT — deployed $TARGET"
  exit 0
fi

log "health check failed; rolling back to $PREV"
git reset --hard "$PREV"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
$SUDO systemctl restart "$SERVICE"
if check_health; then
  log "rolled back to $PREV and healthy again"
else
  log "rollback did NOT come back healthy — check: journalctl -u $SERVICE -n 100"
fi
$SUDO journalctl -u "$SERVICE" -n 40 --no-pager || true
die "deploy of $TARGET failed health check"
