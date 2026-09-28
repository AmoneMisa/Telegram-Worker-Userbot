import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { requireWorkerKey } from '../src/worker-auth.js';
import { registerBotRelay } from '../src/bot-relay.js';

const TOKEN = '123456:ABCdefGhIJKlmNoPQRstuVWXyz0123456789';

async function serve(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function appWith({ key, fetchImpl }) {
  const app = express();
  app.use(requireWorkerKey(key));
  registerBotRelay(app, { enabled: Boolean(key), fetchImpl });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/history', (_req, res) => res.json({ ok: true, messages: [] }));
  return app;
}

test('with a key, the API needs it except for /health', async () => {
  const { base, close } = await serve(appWith({ key: 'k'.repeat(32) }));
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/history`)).status, 401);
    assert.equal((await fetch(`${base}/history`, { headers: { 'X-Worker-Key': 'wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/history`, { headers: { 'X-Worker-Key': 'k'.repeat(32) } })).status, 200);
  } finally { close(); }
});

test('without a key the API stays open and the relay does not exist', async () => {
  const { base, close } = await serve(appWith({ key: '' }));
  try {
    assert.equal((await fetch(`${base}/history`)).status, 200);
    const relay = await fetch(`${base}/telegram/bot${TOKEN}/getMe`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(relay.status, 404);
  } finally { close(); }
});

test('the relay forwards Bot API calls unchanged and returns Telegram\'s answer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  };
  const { base, close } = await serve(appWith({ key: 'k'.repeat(32), fetchImpl }));
  const headers = { 'content-type': 'application/json', 'X-Worker-Key': 'k'.repeat(32) };
  try {
    const res = await fetch(`${base}/telegram/bot${TOKEN}/sendMessage`, { method: 'POST', headers, body: JSON.stringify({ chat_id: 1, text: 'hi' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, result: { message_id: 7 } });
    assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.deepEqual(JSON.parse(calls[0].body), { chat_id: 1, text: 'hi' });
    // Malformed token or method never reaches Telegram.
    assert.equal((await fetch(`${base}/telegram/botnot-a-token/sendMessage`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/telegram/bot${TOKEN}/send..Message`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal(calls.length, 1);
    // Without the key the relay is refused.
    assert.equal((await fetch(`${base}/telegram/bot${TOKEN}/getMe`, { method: 'POST', body: '{}' })).status, 401);
  } finally { close(); }
});
