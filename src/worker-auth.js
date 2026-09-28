import { timingSafeEqual } from 'node:crypto';

// Shared-key check for the worker's HTTP API.
//
// The worker is published on a public address, and /history and /photo read
// channels through the logged-in Telegram account, so without a key anyone who
// finds the port can use that account. With WORKER_API_KEY set, every route
// except /health (the container health check) needs the key in X-Worker-Key.
// Without it the API stays open, so rolling this out never breaks callers that
// do not send the key yet.

export const WORKER_KEY_HEADER = 'x-worker-key';

function sameKey(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireWorkerKey(expected) {
  return (req, res, next) => {
    if (!expected || req.path === '/health') return next();
    if (sameKey(req.get(WORKER_KEY_HEADER), expected)) return next();
    return res.status(401).json({ ok: false, error: 'missing or invalid worker key' });
  };
}
