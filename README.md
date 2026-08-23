# Telegram Worker Userbot

MTProto sidecar used by the Flat Finder and Personal Site backends to read public Telegram channel history without relying on the rate-limited `t.me/s` web preview.

## Runtime

- Node.js 24 LTS
- Express 5
- `teleproto` as the maintained MTProto client (installed under the `telegram` npm alias so existing GramJS-compatible imports and `StringSession` persistence stay compatible)

## Why no Redis

This service intentionally does not use Redis. It is a single-account MTProto worker that serializes Telegram history/media calls in-process, caches resolved entities and hot photo bytes in memory, and persists downloaded photos on disk. Adding Redis would introduce another network dependency without providing a useful consistency boundary unless the worker is deliberately horizontally scaled.

## API

The public worker contract is intentionally small and stable:

- `GET /health`
- `GET /history?channel=<name>&limit=<n>&beforeId=<id>`
- `GET /photo?channel=<name>&id=<messageId>`

Personal Site and Flat Finder depend on this contract, so endpoint names, query parameters and response payload fields should be treated as an inter-service API.

## Configuration

Copy `sample.env` to `worker.env` and fill Telegram credentials. Real process environment variables override values loaded from the file.

Required values:

```env
TG_API_ID=
TG_API_HASH=
TG_SESSION=
```

Generate or replace the session interactively:

```bash
npm run login
npm run login -- --force
```

Optional proxy settings are documented in `sample.env`.

## Development

```bash
npm ci
npm run check
npm start
```

`npm run check` validates the JavaScript/ESM syntax. A real Telegram session is required for a live MTProto smoke test.

## Docker

```bash
docker build -t telegram-worker-userbot .
docker run --rm -p 4100:4100 --env-file worker.env telegram-worker-userbot
```

The container runs as the non-root `node` user. `/app` remains writable because the worker may persist a refreshed Telegram session and the on-disk photo cache there.
