# telegram-worker

A tiny, **transport-only** Telegram MTProto sidecar (GramJS). It logs in once as a
real user account and exposes public-channel history over plain HTTP, so backend
services can read Telegram without the datacenter-IP throttling that cripples the
`t.me/s` web preview. It does **no** domain parsing — it hands raw message
text/date back to the caller.

Shared by multiple apps (e.g. the job finder and the flat finder): each caller
passes its own channels and does its own parsing.

## Endpoints

- `GET /health` → `{ ok }`
- `GET /history?channel=<username>&limit=<n>&beforeId=<id>` →
  `{ ok, messages: [{ id, text, date, hasPhoto, photoIds }], minId }`
- `GET /photo?channel=<username>&id=<messageId>` → raw JPEG bytes (cached)

## Setup

```bash
npm ci
cp sample.env worker.env        # fill in TG_API_ID / TG_API_HASH
set -a && . ./worker.env && set +a && npm run login   # prints TG_SESSION
# put the printed session into worker.env as TG_SESSION=
```

Run it:

```bash
set -a && . ./worker.env && set +a && node index.js
```

Or as a service (systemd) with `EnvironmentFile=/path/worker.env` and
`ExecStart=/usr/bin/node index.js`.

## Deploy notes

- Runs best on a host/region that can reach Telegram's data centers directly.
  If it can't, set `TG_PROXY_*` (see `sample.env`).
- **Do not expose the port publicly.** Reach it from your services over a private
  link (WireGuard/Tailscale), a firewall whitelist of the caller's IP, or a
  Cloudflare tunnel. Callers set their worker URL to that address.

## Security

`TG_SESSION` is full access to the logged-in Telegram account. Keep `worker.env`
`chmod 600`, never commit it, and prefer a dedicated account for the worker.
