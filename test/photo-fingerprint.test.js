import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routes = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');

test('history fingerprints Telegram thumbnail bytes without downloading media', () => {
  const historySection = routes.slice(
    routes.indexOf('function normalizeHistory'),
    routes.indexOf('export function registerRoutes'),
  );

  assert.match(routes, /function photoMetadataFingerprint\(photo\)/);
  assert.match(historySection, /photoFingerprints/);
  assert.doesNotMatch(historySection, /gateway\.getPhoto/);
});

test('full photo fingerprint endpoint reuses the normal photo cache path', () => {
  assert.match(routes, /app\.get\('\/photo-fingerprint'/);
  assert.match(routes, /const buf = await loadPhoto\(channel, id\)/);
  assert.match(routes, /createHash\('sha256'\)\.update\(buf\)\.digest\('hex'\)/);
  assert.match(routes, /algorithm: 'sha256'/);
});
