import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routes = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');

test('history fingerprints Telegram thumbnail bytes without downloading media', () => {
  assert.match(routes, /function photoMetadataFingerprint\(photo\)/);
  assert.match(routes, /photoFingerprints/);
  assert.match(routes, /createHash\('sha256'\)\.update\(buf\)\.digest\('hex'\)/);
  assert.doesNotMatch(routes, /normalizeHistory[\s\S]*gateway\.getPhoto/);
});

test('full photo fingerprint endpoint reuses the normal photo cache path', () => {
  assert.match(routes, /app\.get\('\/photo-fingerprint'/);
  assert.match(routes, /const buf = await loadPhoto\(channel, id\)/);
  assert.match(routes, /algorithm: 'sha256'/);
});
