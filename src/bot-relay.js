import express from 'express';

// Telegram Bot API relay for backend services whose host cannot reach
// api.telegram.org (the whiteslove.me backend's provider blocks Telegram).
// A Bot API call is an HTTPS POST that the MTProto client cannot carry, so this
// passes it through from this host, unchanged:
//
//   POST /telegram/bot<token>/<method>  ->  https://api.telegram.org/bot<token>/<method>
//
// Transport only: the bot keeps its own token and sends it in the path exactly
// as it would to Telegram; nothing is stored or interpreted here. The relay is
// registered only when a worker key is configured, so it can never run as an
// open relay (see worker-auth.js), and the token never reaches the logs.

const TELEGRAM_API = 'https://api.telegram.org';
// getUpdates long-polls; allow its timeout plus headroom.
const RELAY_TIMEOUT_MS = 75_000;
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;
const METHOD_RE = /^[A-Za-z]{1,64}$/;

export function registerBotRelay(app, { enabled, fetchImpl = fetch }) {
  if (!enabled) return false;

  app.post(
    /^\/telegram\/bot([^/]+)\/([^/]+)$/,
    express.json({ limit: '1mb' }),
    async (req, res) => {
      const token = req.params[0];
      const method = req.params[1];
      if (!TOKEN_RE.test(token) || !METHOD_RE.test(method)) {
        return res.status(400).json({ ok: false, description: 'bad token or method' });
      }
      try {
        const upstream = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req.body ?? {}),
          signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
        });
        const body = await upstream.text();
        res.status(upstream.status).type('application/json').send(body);
      } catch (err) {
        console.warn(`[tg-worker] bot relay ${method} failed: ${err?.name ?? 'error'}`);
        res.status(502).json({ ok: false, description: 'telegram unreachable from relay' });
      }
    },
  );
  return true;
}
