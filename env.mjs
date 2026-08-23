// Zero-dependency .env loading/writing.
//
// The worker may run from a shell, Docker or CI. The process loads the local
// .env file itself so interactive login can persist a refreshed Telegram
// session without requiring shell-specific export commands.
//
// Real environment variables always win: values already present in process.env
// are never overwritten, so Docker/CI stay authoritative.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

export function envFilePath() {
  return path.resolve(process.cwd(), '.env');
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.at(-1) === q) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(file = envFilePath()) {
  if (!existsSync(file)) return {};
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function loadEnv() {
  const file = envFilePath();
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.warn('[tg-worker] could not read ' + file + ': ' + err.message);
    return null;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
  return file;
}

export function writeEnvVar(key, value, file = envFilePath()) {
  const line = key + '=' + value;
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const re = new RegExp('^[ \\t]*#?[ \\t]*(?:export[ \\t]+)?' + key + '[ \\t]*=.*$', 'm');
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += line + '\n';
  }
  writeFileSync(file, text, 'utf8');
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX permissions.
  }
  return file;
}
