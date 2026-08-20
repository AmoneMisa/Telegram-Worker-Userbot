// Telegram MTProto sidecar (GramJS).
//
// The backend used to scrape https://t.me/s/<channel>, but Telegram heavily
// throttles that web preview from datacenter IPs (a production server saw ~1
// post where a browser sees hundreds). This worker instead logs in once as a real user account
// and calls messages.getHistory. This replaced scraping https://t.me/s/<channel>
// because Telegram heavily throttles that web preview from datacenter IPs (a
// production server saw ~1 post where a browser sees hundreds). The worker is
// transport-only: it returns raw message text/date, and all the housing
// parsing/filtering below stays here so there's a single source of truth.

import express from 'express';
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { loadEnv, envFilePath, readEnvFile, writeEnvVar } from './env.mjs';
import { interactiveLogin, isDeadSession, canPrompt } from './session.mjs';

// Pick up worker.env (or TG_ENV_FILE) automatically, so `npm start` works on a
// bare shell. Anything already exported — systemd, Docker, CI — wins over it.
const envFile = loadEnv();
if (envFile) console.log('[tg-worker] loaded env from ' + envFile);

let apiId = Number(process.env.TG_API_ID);
let apiHash = process.env.TG_API_HASH;
let session = process.env.TG_SESSION || '';
const port = Number(process.env.PORT) || 4100;

// Only values that came from the env file are ours to rewrite. If TG_SESSION
// was injected by systemd/Docker/CI, that source owns it and we leave it alone.
const fileValues = readEnvFile();
const sessionIsOurs = !session || fileValues.TG_SESSION === session;

function persist(key, value) {
  if (!sessionIsOurs) return false;
  try {
    writeEnvVar(key, value, envFile ?? envFilePath());
    return true;
  } catch (err) {
    console.warn('[tg-worker] could not save ' + key + ': ' + (err?.message ?? err));
    return false;
  }
}

// Log in right here rather than making the operator run a second command. Only
// possible with a terminal to ask on: Telegram mints a session against a
// one-time code it sends to the account, and nothing can read that code for
// us. Headless (systemd, Docker) therefore still exits with instructions.
async function login(reason) {
  console.warn('[tg-worker] ' + reason);
  if (!canPrompt()) {
    console.error(
      '[tg-worker] no terminal to log in on. Run `npm run login` in an interactive\n' +
        '[tg-worker] shell (here over ssh, or on your laptop — the session string is\n' +
        '[tg-worker] portable), then start the service again.',
    );
    process.exit(1);
  }
  let creds;
  try {
    creds = await interactiveLogin({ apiId, apiHash, label: 'tg-worker' });
  } catch (err) {
    // A mistyped credential or an abandoned prompt shouldn't dump a stack.
    console.error('[tg-worker] login failed: ' + (err?.errorMessage || err?.message || err));
    process.exit(1);
  }
  apiId = creds.apiId;
  apiHash = creds.apiHash;
  session = creds.session;
  persist('TG_API_ID', String(apiId));
  persist('TG_API_HASH', apiHash);
  const saved = persist('TG_SESSION', session);
  console.log(
    saved
      ? '[tg-worker] session saved to ' + (envFile ?? envFilePath()) + ' — this was a one-off.'
      : '[tg-worker] session NOT saved (it is supplied from the environment) — ' +
          'update that source or the next start asks again.',
  );
  return session;
}

if (!apiId || !apiHash || !session) {
  const missing = [!apiId && 'TG_API_ID', !apiHash && 'TG_API_HASH', !session && 'TG_SESSION']
    .filter(Boolean)
    .join(', ');
  await login(
    'missing ' +
      missing +
      (envFile ? ' in ' + envFile : ' (no env file at ' + envFilePath() + ')') +
      ' — starting login.',
  );
}

// Optional outbound proxy. Some hosts block direct egress to Telegram's
// datacenters (a plain TCP connect to 149.154.x / 91.108.x times out even
// though the rest of the internet is reachable). Point the worker at a
// SOCKS5 proxy (or a Telegram MTProxy) that CAN reach Telegram to route
// around the block. Unset -> direct connection, unchanged behaviour.
//   SOCKS5:  TG_PROXY_HOST, TG_PROXY_PORT, [TG_PROXY_USER, TG_PROXY_PASS]
//   MTProxy: TG_PROXY_HOST, TG_PROXY_PORT, TG_PROXY_SECRET
function buildProxy() {
  const ip = process.env.TG_PROXY_HOST;
  const port = Number(process.env.TG_PROXY_PORT);
  if (!ip || !port) return undefined;
  const secret = process.env.TG_PROXY_SECRET;
  if (secret) {
    console.log(`[tg-worker] using MTProxy ${ip}:${port}`);
    return { ip, port, MTProxy: true, secret };
  }
  console.log(`[tg-worker] using SOCKS5 proxy ${ip}:${port}`);
  return {
    ip,
    port,
    socksType: 5,
    ...(process.env.TG_PROXY_USER
      ? { username: process.env.TG_PROXY_USER, password: process.env.TG_PROXY_PASS || '' }
      : {}),
  };
}

function buildClient(sessionString) {
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    // Auto-wait through short FLOOD_WAITs (Telegram asking us to slow down)
    // instead of erroring; anything longer than this surfaces as an error.
    floodSleepThreshold: 60,
    proxy: buildProxy(),
  });
}

// A truncated/garbled session string (a bad paste into worker.env) otherwise
// dies inside GramJS's binary reader with a stack trace that says nothing about
// what to do next. Re-mint it instead of dying.
let client;
while (!client) {
  try {
    client = buildClient(session);
  } catch (err) {
    await login('TG_SESSION is not a valid session string (' + (err?.message ?? err) + ').');
  }
}

// Set once Telegram tells us the session is gone (revoked from the Devices
// list, account deactivated, auth key dropped). Reported on /health, because
// otherwise a dead session looks exactly like a healthy worker whose every
// request happens to 502.
let sessionDead = null;
function noteTelegramError(err) {
  if (!isDeadSession(err)) return;
  const msg = err?.errorMessage || err?.message || String(err);
  if (!sessionDead) {
    console.error(
      '[tg-worker] the Telegram session is no longer valid (' +
        msg +
        ').\n[tg-worker] Re-mint it with:  npm run login -- --force   ' +
        '(needs a terminal — Telegram sends a one-time code)',
    );
  }
  sessionDead = msg;
}

// Resolving a @username to an entity is itself an API call, so cache the
// resolved entity per channel for the process lifetime.
const entityCache = new Map();
async function resolve(channel) {
  if (entityCache.has(channel)) return entityCache.get(channel);
  const entity = await client.getEntity(channel);
  entityCache.set(channel, entity);
  return entity;
}

// Serialize all history calls through a single-lane queue. Firing many MTProto
// requests in parallel from one account is the fastest way to trip FLOOD_WAIT
// or an account limit, so we trade a little latency for safety.
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  // Keep the chain alive regardless of individual task outcome.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Small in-memory LRU for downloaded photo bytes, so repeated views of the same
// listing (or several users) don't each re-download from Telegram — every
// download is a rate-limited API call. The real long-term cache is client-side
// (the app's cached_network_image + the HTTP cache headers the backend sets);
// this just absorbs bursts. Capped by entry count to bound memory.
const PHOTO_CACHE_MAX = 300;
const photoCache = new Map(); // "channel/id" -> Buffer
function cacheGetPhoto(key) {
  const buf = photoCache.get(key);
  if (buf) {
    // Refresh recency (Map preserves insertion order).
    photoCache.delete(key);
    photoCache.set(key, buf);
  }
  return buf;
}
function cacheSetPhoto(key, buf) {
  photoCache.set(key, buf);
  while (photoCache.size > PHOTO_CACHE_MAX) {
    photoCache.delete(photoCache.keys().next().value);
  }
}

// Persistent (on-disk) photo cache. Every downloadMedia is a rate-limited
// MTProto call, so once a photo's bytes are on disk we serve them from there on
// a miss instead of re-downloading — this survives restarts and scales far past
// the small in-memory LRU. Files are pruned by age (see below) so the folder
// tracks the same freshness window as the listings themselves.
const PHOTO_DIR = process.env.TG_PHOTO_DIR || path.join(process.cwd(), 'photo-cache');
const PHOTO_MAX_AGE_MS =
  (Number(process.env.TG_PHOTO_MAX_AGE_DAYS) || 21) * 24 * 60 * 60 * 1000;
await mkdir(PHOTO_DIR, { recursive: true }).catch(() => {});

function diskPathFor(channel, id) {
  // channel/id are validated upstream, but sanitise anyway so the value can
  // never escape PHOTO_DIR.
  const safe = String(channel).replace(/[^A-Za-z0-9_]/g, '_');
  return path.join(PHOTO_DIR, `${safe}_${id}.jpg`);
}

// Delete cached photos whose files are older than the freshness window. Posts
// that old are already filtered out of results, so their images are dead weight.
async function cleanupPhotoDir() {
  try {
    const files = await readdir(PHOTO_DIR);
    const now = Date.now();
    let removed = 0;
    for (const f of files) {
      const p = path.join(PHOTO_DIR, f);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > PHOTO_MAX_AGE_MS) {
          await unlink(p);
          removed += 1;
        }
      } catch {
        // File vanished or unreadable — ignore.
      }
    }
    if (removed) console.log(`[tg-worker] photo cache: pruned ${removed} old file(s)`);
  } catch {
    // Directory missing/unreadable — nothing to prune.
  }
}

const app = express();

app.get('/health', (_req, res) => {
  res.json({
    ok: client.connected === true && sessionDead === null,
    ...(sessionDead ? { error: 'session invalid: ' + sessionDead, fix: 'npm run login -- --force' } : {}),
  });
});

// GET /photo?channel=<name>&id=<messageId>
// Downloads the photo attached to one message and returns the raw JPEG bytes.
// Lazy (only when a client actually views the listing) and cached, since media
// downloads are themselves rate-limited MTProto calls.
app.get('/photo', async (req, res) => {
  const channel = String(req.query.channel || '').trim();
  const id = Number(req.query.id);
  if (!channel || !Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: 'channel and numeric id required' });
  }
  const key = `${channel}/${id}`;

  try {
    let buf = cacheGetPhoto(key);
    if (!buf) {
      // Try the on-disk cache before spending a rate-limited MTProto download.
      const file = diskPathFor(channel, id);
      buf = await readFile(file).catch(() => null);
      if (buf) {
        cacheSetPhoto(key, buf);
      } else {
        buf = await enqueue(async () => {
          const entity = await resolve(channel);
          const [msg] = await client.getMessages(entity, { ids: [id] });
          if (!msg || !msg.photo) return null;
          return client.downloadMedia(msg, {});
        });
        if (!buf) return res.status(404).json({ ok: false, error: 'no photo' });
        cacheSetPhoto(key, buf);
        // Persist for future misses / restarts (best-effort).
        writeFile(file, buf).catch(() => {});
      }
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(buf);
  } catch (err) {
    const msg = err?.message ?? String(err);
    noteTelegramError(err);
    console.warn(`[tg-worker] photo ${key} failed: ${msg}`);
    res.status(502).json({ ok: false, error: msg });
  }
});

function extractMessageUrls(message, text, webpage) {
  const urls = [];

  for (const entity of message.entities || []) {
    // MessageEntityTextUrl carries the hidden destination directly.
    if (typeof entity.url === 'string') {
      urls.push(entity.url);
      continue;
    }

    // MessageEntityUrl points at a visible URL inside the message text. Telegram
    // offsets are UTF-16 code units, which matches JavaScript String.slice().
    if (Number.isInteger(entity.offset) && Number.isInteger(entity.length)) {
      const visible = text.slice(entity.offset, entity.offset + entity.length);
      if (/^https?:\/\//i.test(visible)) urls.push(visible);
    }
  }

  if (typeof webpage?.url === 'string') urls.push(webpage.url);

  // Inline keyboard URL buttons are exactly what Telegram Mobile exposes via
  // the "Open link" popup, and they are not part of m.message.
  for (const row of message.replyMarkup?.rows || []) {
    for (const button of row.buttons || []) {
      if (typeof button.url === 'string') urls.push(button.url);
    }
  }

  return [...new Set(urls.filter((url) => /^https?:\/\//i.test(url)))];
}

// GET /history?channel=<name>&limit=<n>&beforeId=<id>
//   channel  : public channel username (without @)
//   limit    : max messages to return (default 100)
//   beforeId : paginate to messages older than this id (the `offsetId` cursor)
//
// Returns { ok, messages: [{ id, text, date, hasPhoto, urls }], minId }.
app.get('/history', async (req, res) => {
  const channel = String(req.query.channel || '').trim();
  if (!channel) return res.status(400).json({ ok: false, error: 'channel required' });
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const beforeId = Number(req.query.beforeId) || 0;

  try {
    const messages = await enqueue(async () => {
      const entity = await resolve(channel);
      return client.getMessages(entity, { limit, offsetId: beforeId });
    });

    // Telegram sends a multi-photo post (album) as several messages that share
    // a groupedId; typically only one carries the caption text and the others
    // are photo-only (and would be dropped by the no-text skip below). Collect
    // every photo message id per album so the caption message can expose the
    // whole gallery instead of just its own single image.
    const albumPhotoIds = new Map(); // groupedId -> [messageId,...]
    let minId = null;
    for (const m of messages) {
      if (typeof m.id === 'number') {
        minId = minId === null ? m.id : Math.min(minId, m.id);
      }
      const gid = m.groupedId != null ? String(m.groupedId) : null;
      if (gid && m.photo) {
        if (!albumPhotoIds.has(gid)) albumPhotoIds.set(gid, []);
        albumPhotoIds.get(gid).push(m.id);
      }
    }
    for (const ids of albumPhotoIds.values()) ids.sort((a, b) => a - b);

    const out = [];
    const seenAlbums = new Set();
    for (const m of messages) {
      const text = m.message || '';
      if (!text) continue; // service messages, pure media with no caption, etc.
      const gid = m.groupedId != null ? String(m.groupedId) : null;
      let photoIds;
      if (gid) {
        if (seenAlbums.has(gid)) continue; // album already emitted via its caption
        seenAlbums.add(gid);
        photoIds = albumPhotoIds.get(gid) ?? (m.photo ? [m.id] : []);
      } else {
        photoIds = m.photo ? [m.id] : [];
      }
      // Link-preview (webpage) title/description often carries details that are
      // not in the message text — e.g. salary shown on the linked job page.
      const wp = m.media && m.media.webpage;
      const preview = wp && (wp.title || wp.description)
        ? [wp.title, wp.description].filter(Boolean).join('. ').trim()
        : null;
      const urls = extractMessageUrls(m, text, wp);
      out.push({
        id: m.id,
        text,
        // GramJS exposes the unix timestamp (seconds) as `date`.
        date: m.date ? new Date(m.date * 1000).toISOString() : null,
        hasPhoto: photoIds.length > 0,
        photoIds, // every image id in the post (album-aware)
        preview, // webpage preview title+description, or null
        urls, // visible URLs + hidden text links + inline-button destinations
      });
    }
    res.json({ ok: true, messages: out, minId });
  } catch (err) {
    const msg = err?.message ?? String(err);
    noteTelegramError(err);
    console.warn(`[tg-worker] @${channel} failed: ${msg}`);
    res.status(502).json({ ok: false, error: msg });
  }
});

// Connect, then prove the session actually works. A revoked session connects
// happily and only fails on the first real call, which would otherwise turn
// into "the worker is up but everything 502s" hours later.
async function connectAndVerify() {
  await client.connect();
  try {
    return await client.getMe();
  } catch (err) {
    if (!isDeadSession(err)) throw err;
    await login(
      'the stored session is no longer valid (' +
        (err?.errorMessage || err?.message || err) +
        ') — it was probably revoked from Telegram > Settings > Devices.',
    );
    await client.disconnect().catch(() => {});
    client = buildClient(session);
    await client.connect();
    return client.getMe();
  }
}

const me = await connectAndVerify();
console.log(
  '[tg-worker] connected to Telegram as ' +
    (me?.username ? '@' + me.username : [me?.firstName, me?.lastName].filter(Boolean).join(' ')),
);

// Telegram can hand back an updated session (a datacenter migration rewrites
// it on the first call). Persisting it means the stored string never drifts
// out of date behind our back and forces a manual re-login later.
function persistSessionIfChanged() {
  if (!sessionIsOurs || sessionDead) return;
  let current;
  try {
    current = client.session.save();
  } catch {
    return; // Session not in a saveable state right now; try again next tick.
  }
  if (current && current !== session) {
    session = current;
    if (persist('TG_SESSION', current)) console.log('[tg-worker] stored session refreshed');
  }
}
persistSessionIfChanged();
const sessionTimer = setInterval(persistSessionIfChanged, 60 * 60 * 1000);
if (sessionTimer.unref) sessionTimer.unref();

// Prune the on-disk photo cache on boot and every 6 hours thereafter.
cleanupPhotoDir();
const cleanupTimer = setInterval(cleanupPhotoDir, 6 * 60 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

app.listen(port, () => console.log(`[tg-worker] listening on :${port}`));
