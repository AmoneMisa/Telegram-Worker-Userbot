# telegram-worker

A tiny, **transport-only** Telegram MTProto sidecar (`teleproto`, the maintained
successor to GramJS). It logs in once as a real user account and exposes
public-channel history over plain HTTP, so backend services can read Telegram
without the datacenter-IP throttling that cripples the `t.me/s` web preview. It
does **no** domain parsing — it hands raw message text/date back to the caller.

Shared by multiple apps (e.g. the job finder and the flat finder): each caller
passes its own channels and does its own parsing.

The npm dependency is installed as `telegram: npm:teleproto@...` deliberately:
`teleproto` is largely GramJS-compatible, so the existing import paths and saved
`StringSession` values remain compatible while the runtime moves off the archived
GramJS package.

## Endpoints

- `GET /health` → `{ ok }`
- `GET /history?channel=<username>&limit=<n>&beforeId=<id>` →
  `{ ok, messages: [{ id, text, date, hasPhoto, photoIds, preview }], minId }`
- `GET /photo?channel=<username>&id=<messageId>` → raw JPEG bytes (cached)

These endpoints and payload fields are an inter-service API used by Personal
Site and Flat Finder. Keep them backward-compatible unless callers are migrated
in the same change.

## Architecture

Redis is intentionally not part of this service. The worker is single-account
and single-process: MTProto calls are serialized in-process, entity/hot-photo
caches are process-local, and downloaded photos are persisted on disk. Redis
would add a network dependency without a useful consistency boundary unless the
worker is deliberately redesigned for horizontal scaling.

## Setup

Node.js 24 LTS is the supported runtime.

```bash
npm ci
npm start
```

That's it. `npm start` creates `worker.env` from `sample.env`, asks for
`TG_API_ID` / `TG_API_HASH` (from [my.telegram.org](https://my.telegram.org) →
API development tools) and walks you through the phone + code + 2FA login if it
has no usable session, saves everything to `worker.env` (`chmod 600`), and boots.
No `set -a && . ./worker.env` dance, no second command, no copy-paste.

`npm run login` runs the same flow on its own, for when you want to log in ahead
of time, on a different machine (the session string is portable), or to replace
a session that still works (`npm run login -- --force`).

Real environment variables always win over the file, so systemd, Docker and CI
stay authoritative. Point it at a different file with `TG_ENV_FILE=/path/to.env`.

## Session lifecycle

What happens by itself:

- **Restarts, reboots, redeploys** — no re-login. The session string is not a
  login attempt; it stays valid indefinitely.
- **Datacenter migrations** — Telegram sometimes hands back a rewritten session.
  The worker notices and saves it back to `worker.env`, so the stored copy never
  goes stale behind your back.
- **First boot with nothing configured** — the login runs inline, as above.
- **A session that was revoked** — checked at boot (with a `getMe` call) and on
  every request, so it can't hide behind sporadic 502s. `/health` flips to
  `{ ok: false, error: "session invalid: ...", fix: "npm run login -- --force" }`
  and the log says the same. Note this also fails a deploy's health check, which
  will roll the code back — the journal line tells you it was the session, not
  the release.

What can't: **minting a session always needs a human.** Telegram issues one only
against a one-time code sent to the account, and reading that code requires an
already-valid session. So a headless start with no session exits with
instructions rather than hanging on a prompt nobody can answer — run
`npm run login` over an interactive ssh session (or on your laptop) and the
worker is autonomous again until you revoke it.

## Server install

One-time bootstrap (clones the repo, creates `worker.env`, installs deps and a
systemd unit, enables it):

```bash
curl -fsSL https://raw.githubusercontent.com/AmoneMisa/Telegram-Worker-Userbot/master/deploy/install.sh | sudo bash
```

Then log in once and start it:

```bash
cd /opt/tg-worker && npm run login && systemctl start tg-worker
```

Knobs: `APP_DIR` (default `/opt/tg-worker`), `SERVICE` (`tg-worker`), `RUN_USER`
(current user), `BRANCH` (`master`). Logs: `journalctl -u tg-worker -f`.

## Autodeploy

Every push to `master` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):
it checks the lockfile and syntax, then pipes [`deploy/deploy.sh`](deploy/deploy.sh)
into a shell on the server over ssh. The script fast-forwards the checkout to
`origin/master`, runs `npm ci --omit=dev`, restarts the service and polls
`/health`. **If the new revision doesn't come up healthy it is rolled back to the
previous commit automatically** and the job fails.

Set it up once:

1. On the server, create a deploy key and authorize it:

   ```bash
   ssh-keygen -t ed25519 -N '' -C 'github-actions' -f ~/.ssh/tg_worker_deploy
   cat ~/.ssh/tg_worker_deploy.pub >> ~/.ssh/authorized_keys
   cat ~/.ssh/tg_worker_deploy          # the private half, for the secret below
   ssh-keyscan -H "$(hostname -I | awk '{print $1}')"   # for DEPLOY_KNOWN_HOSTS
   ```

2. In GitHub → Settings → Secrets and variables → Actions, add:

   | Secret | Required | Meaning |
   | --- | --- | --- |
   | `DEPLOY_HOST` | yes | server hostname or IP |
   | `DEPLOY_USER` | yes | ssh user (e.g. `root`) |
   | `DEPLOY_SSH_KEY` | yes | the private key printed above |
   | `DEPLOY_PORT` | no | ssh port, default `22` |
   | `DEPLOY_KNOWN_HOSTS` | no | host key line; without it the key is trusted on first use |
   | `DEPLOY_PATH` | no | checkout path, default `/opt/tg-worker` |
   | `DEPLOY_SERVICE` | no | unit name, default `tg-worker` |

   Or do the whole step from a shell — the key is piped from the file into
   `gh`, so it never lands in your history:

   ```bash
   ./deploy/setup-secrets.sh --host 1.2.3.4 --user root --key ~/.ssh/tg_worker_deploy
   ```

3. Push to `master` (or run the workflow manually from the Actions tab).

Deploying by hand is the same script:

```bash
sudo /opt/tg-worker/deploy/deploy.sh
```

Note that `/opt/tg-worker` is a deployment target, not a workspace — the script
does `git reset --hard`, so local edits there are discarded. `worker.env` and
`photo-cache/` are gitignored and survive.

## Deploy notes

- Runs best on a host/region that can reach Telegram's data centers directly.
  If it can't, set `TG_PROXY_*` (see `sample.env`).
- **Do not expose the port publicly.** Reach it from your services over a private
  link (WireGuard/Tailscale), a firewall whitelist of the caller's IP, or a
  Cloudflare tunnel. Callers set their worker URL to that address.

## Security

`TG_SESSION` is full access to the logged-in Telegram account. Keep `worker.env`
`chmod 600`, never commit it, and prefer a dedicated account for the worker.
The deploy key gives GitHub Actions shell access to the server — use a key
dedicated to this repo and nothing else.
