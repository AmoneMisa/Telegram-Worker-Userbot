#!/usr/bin/env bash
#
# Set the autodeploy secrets on the GitHub repo, locally, via the gh CLI.
#
# The private key is read from a file and piped straight into `gh secret set` —
# it is never echoed, never passed as an argument (argv is visible to other
# processes), and never ends up in your shell history.
#
#   ./deploy/setup-secrets.sh --host 1.2.3.4 --user root --key ~/.ssh/tg_worker_deploy
#
# Options:
#   --host HOST     server hostname or IP            (prompted if omitted)
#   --user USER     ssh user on the server           (default root)
#   --key  PATH     private key file                 (prompted if omitted)
#   --port PORT     ssh port                         (default 22, secret set only if != 22)
#   --path DIR      checkout on the server           (default /opt/tg-worker, only if custom)
#   --service NAME  systemd unit                     (default tg-worker, only if custom)
#   --repo  OWNER/NAME  target repo (default: the origin remote of this checkout)

set -euo pipefail

HOST="" USER_NAME="root" KEY="" PORT="22" APP_PATH="" SERVICE="" REPO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --path) APP_PATH="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v gh >/dev/null 2>&1 || {
  echo "gh (GitHub CLI) is not installed — https://cli.github.com" >&2
  echo "  Windows:  winget install --id GitHub.cli" >&2
  exit 1
}
gh auth status >/dev/null 2>&1 || { echo "run 'gh auth login' first" >&2; exit 1; }

[ -n "$HOST" ] || read -r -p "Server host or IP: " HOST
[ -n "$KEY" ] || read -r -p "Path to the deploy PRIVATE key file: " KEY
KEY="${KEY/#\~/$HOME}"
[ -f "$KEY" ] || { echo "no such file: $KEY" >&2; exit 1; }
grep -q 'PRIVATE KEY' "$KEY" || {
  echo "$KEY does not look like a private key (did you point at the .pub?)" >&2
  exit 1
}

set_secret() { gh secret set "$1" ${REPO:+--repo "$REPO"} --body "$2" >/dev/null && echo "  set $1"; }

echo "Setting secrets on ${REPO:-the origin repo}:"
gh secret set DEPLOY_SSH_KEY ${REPO:+--repo "$REPO"} < "$KEY" >/dev/null && echo "  set DEPLOY_SSH_KEY"
set_secret DEPLOY_HOST "$HOST"
set_secret DEPLOY_USER "$USER_NAME"
[ "$PORT" = "22" ] || set_secret DEPLOY_PORT "$PORT"
[ -z "$APP_PATH" ] || set_secret DEPLOY_PATH "$APP_PATH"
[ -z "$SERVICE" ] || set_secret DEPLOY_SERVICE "$SERVICE"

# Pinning the host key turns the ssh step from trust-on-first-use into a real
# check, so a hijacked DNS record can't collect the deploy key.
if command -v ssh-keyscan >/dev/null 2>&1; then
  if known="$(ssh-keyscan -p "$PORT" -H "$HOST" 2>/dev/null)" && [ -n "$known" ]; then
    set_secret DEPLOY_KNOWN_HOSTS "$known"
  else
    echo "  (ssh-keyscan got nothing — skipping DEPLOY_KNOWN_HOSTS, first-use trust applies)"
  fi
fi

echo
gh secret list ${REPO:+--repo "$REPO"}
echo
echo "Now push to master, or trigger it by hand:"
echo "  gh workflow run deploy.yml${REPO:+ --repo $REPO}"
