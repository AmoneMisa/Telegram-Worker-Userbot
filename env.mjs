// Zero-dependency .env loading/writing.
//
// The worker gets started in a lot of different ways — a bare `npm start` from
// a shell, systemd with an EnvironmentFile, Docker with -e, CI — and every one
// of them used to require the operator to remember
// `set -a && . ./worker.env && set +a` first. Forgetting it produced the
// unhelpful "TG_API_ID, TG_API_HASH and TG_SESSION are required" exit. So the
// process now loads its own env file, and `npm run login` writes the freshly
// minted session straight back into it.
//
// Real environment variables always win: values already present in process.env
// are never overwritten, so systemd/Docker/CI stay authoritative.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

// Candidate file names, in order. TG_ENV_FILE overrides all of them.
const CANDIDATES = ['worker.env', '.env', 'flatfinder.env'];

export function envFilePath() {
  if (process.env.TG_ENV_FILE) return path.resolve(process.env.TG_ENV_FILE);
  for (const name of CANDIDATES) {
    const p = path.resolve(process.cwd(), name);
    if (existsSync(p)) return p;
  }
  // Nothing on disk yet — worker.env is where we would create one.
  return path.resolve(process.cwd(), CANDIDATES[0]);
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
    // Strip one layer of matching quotes; leave the contents alone otherwise.
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.at(-1) === q) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// The env file's own values, without touching process.env. Used to tell a
// value that came from the file (ours to rewrite) from one injected by
// systemd/Docker/CI (not ours to touch).
export function readEnvFile(file = envFilePath()) {
  if (!existsSync(file)) return {};
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Load the env file into process.env without clobbering existing values.
// Returns the path it read, or null if there was nothing to read.
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

// Set one KEY=value in the env file, replacing an existing (or commented-out)
// entry in place so the file keeps its comments and its ordering.
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
  // The file holds a full-account session string; keep it owner-only.
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows / exotic filesystems — best effort.
  }
  return file;
}
