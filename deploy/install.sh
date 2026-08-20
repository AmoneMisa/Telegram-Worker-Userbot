#!/usr/bin/env bash
#
# One-time server bootstrap: clone (or adopt) the checkout, create worker.env,
# install the systemd unit and enable it. Idempotent — safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/AmoneMisa/Telegram-Worker-Userbot/master/deploy/install.sh | sudo bash
#   # or, from an existing checkout:
#   sudo ./deploy/install.sh
#
# Knobs (env vars):
#   APP_DIR   where to install        (default /opt/tg-worker)
#   SERVICE   systemd unit name       (default tg-worker)
#   RUN_USER  user to run as          (default the current user, i.e. root)
#   BRANCH    branch to track         (default master)
#   REPO      git url to clone from   (default this project's GitHub repo)

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tg-worker}"
SERVICE="${SERVICE:-tg-worker}"
RUN_USER="${RUN_USER:-$(id -un)}"
BRANCH="${BRANCH:-master}"
REPO="${REPO:-https://github.com/AmoneMisa/Telegram-Worker-Userbot.git}"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
for bin in git node npm curl systemctl; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is not installed"
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required, found $(node -v)"

if [ -d "$APP_DIR/.git" ]; then
  log "reusing existing checkout at $APP_DIR"
else
  log "cloning $REPO into $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f worker.env ]; then
  cp sample.env worker.env
  log "created $APP_DIR/worker.env from sample.env"
fi
chmod 600 worker.env

log "installing production dependencies"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# After npm, so node_modules/ ends up owned by the service user too. The worker
# writes photo-cache/ inside APP_DIR at runtime, so it needs the directory.
chown -R "$RUN_USER" "$APP_DIR"

log "installing systemd unit /etc/systemd/system/$SERVICE.service"
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__USER__|$RUN_USER|g" \
  deploy/tg-worker.service > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

# Starting without a session would just crash-loop, so gate on it.
if grep -Eq '^[[:space:]]*TG_SESSION[[:space:]]*=[[:space:]]*[^[:space:]]' worker.env; then
  log "starting $SERVICE"
  systemctl restart "$SERVICE"
  sleep 3
  systemctl is-active --quiet "$SERVICE" && log "$SERVICE is running" || {
    journalctl -u "$SERVICE" -n 30 --no-pager || true
    die "$SERVICE failed to start"
  }
else
  cat <<MSG

[install] Almost done — the account is not logged in yet.

  Run this once, in an interactive shell (here over ssh, or on your laptop —
  the session string is portable):

      cd $APP_DIR
      npm run login          # asks for API id/hash, phone number and the code

  It writes TG_API_ID / TG_API_HASH / TG_SESSION into worker.env, then:

      systemctl start $SERVICE

MSG
fi
