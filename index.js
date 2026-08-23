// Telegram MTProto sidecar. The HTTP layer is deliberately transport-only:
// callers own all domain parsing and filtering.

import express from 'express';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { loadEnv, envFilePath, readEnvFile, writeEnvVar } from './env.mjs';
import { interactiveLogin, isDeadSession, canPrompt } from './session.mjs';
import { createTelegramGateway } from './src/telegram-gateway.js';
import { createPhotoCache } from './src/photo-cache.js';
import { registerRoutes } from './src/routes.js';

const envFile = loadEnv();
if (envFile) console.log('[tg-worker] loaded env from ' + envFile);

let apiId = Number(process.env.TG_API_ID);
let apiHash = process.env.TG_API_HASH;
let session = process.env.TG_SESSION || '';
const port = Number(process.env.PORT) || 4100;

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

function buildProxy() {
  const ip = process.env.TG_PROXY_HOST;
  const proxyPort = Number(process.env.TG_PROXY_PORT);
  if (!ip || !proxyPort) return undefined;
  const secret = process.env.TG_PROXY_SECRET;
  if (secret) {
    console.log(`[tg-worker] using MTProxy ${ip}:${proxyPort}`);
    return { ip, port: proxyPort, MTProxy: true, secret };
  }
  console.log(`[tg-worker] using SOCKS5 proxy ${ip}:${proxyPort}`);
  return {
    ip,
    port: proxyPort,
    socksType: 5,
    ...(process.env.TG_PROXY_USER
      ? { username: process.env.TG_PROXY_USER, password: process.env.TG_PROXY_PASS || '' }
      : {}),
  };
}

function buildClient(sessionString) {
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 60,
    proxy: buildProxy(),
  });
}

let client;
while (!client) {
  try {
    client = buildClient(session);
  } catch (err) {
    await login('TG_SESSION is not a valid session string (' + (err?.message ?? err) + ').');
  }
}

let sessionDead = null;
function noteTelegramError(err) {
  if (!isDeadSession(err)) return;
  const msg = err?.errorMessage || err?.message || String(err);
  if (!sessionDead) {
    console.error(
      '[tg-worker] the Telegram session is no longer valid (' +
        msg +
        ').\n[tg-worker] Re-mint it with: npm run login -- --force ' +
        '(needs a terminal — Telegram sends a one-time code)',
    );
  }
  sessionDead = msg;
}

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

function persistSessionIfChanged() {
  if (!sessionIsOurs || sessionDead) return;
  let current;
  try {
    current = client.session.save();
  } catch {
    return;
  }
  if (current && current !== session) {
    session = current;
    if (persist('TG_SESSION', current)) console.log('[tg-worker] stored session refreshed');
  }
}

persistSessionIfChanged();
const sessionTimer = setInterval(persistSessionIfChanged, 60 * 60 * 1000);
if (sessionTimer.unref) sessionTimer.unref();

const gateway = createTelegramGateway({
  getClient: () => client,
  onError: noteTelegramError,
});
const photoCache = await createPhotoCache();

photoCache.cleanup();
const cleanupTimer = setInterval(() => photoCache.cleanup(), 6 * 60 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

const app = express();
registerRoutes(app, {
  gateway,
  photoCache,
  health: () => ({
    ok: client.connected === true && sessionDead === null,
    ...(sessionDead
      ? { error: 'session invalid: ' + sessionDead, fix: 'npm run login -- --force' }
      : {}),
  }),
});

// Containers must listen on all interfaces. Binding implicitly can resolve to
// IPv6-only on some Node/host combinations, leaving Docker's IPv4 published
// port unreachable even though the process reports that it is listening.
app.listen(port, '0.0.0.0', () => console.log(`[tg-worker] listening on 0.0.0.0:${port}`));