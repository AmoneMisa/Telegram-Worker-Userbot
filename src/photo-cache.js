import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function createPhotoCache({
  dir = process.env.TG_PHOTO_DIR || path.join(process.cwd(), 'photo-cache'),
  maxEntries = 300,
  maxAgeDays = Number(process.env.TG_PHOTO_MAX_AGE_DAYS) || 21,
} = {}) {
  const memory = new Map();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  await mkdir(dir, { recursive: true }).catch(() => {});

  function keyFor(channel, id) {
    return `${channel}/${id}`;
  }

  function fileFor(channel, id) {
    const safe = String(channel).replace(/[^A-Za-z0-9_]/g, '_');
    return path.join(dir, `${safe}_${id}.jpg`);
  }

  function getMemory(key) {
    const buf = memory.get(key);
    if (buf) {
      memory.delete(key);
      memory.set(key, buf);
    }
    return buf;
  }

  function setMemory(key, buf) {
    memory.set(key, buf);
    while (memory.size > maxEntries) {
      memory.delete(memory.keys().next().value);
    }
  }

  async function get(channel, id) {
    const key = keyFor(channel, id);
    let buf = getMemory(key);
    if (buf) return buf;

    buf = await readFile(fileFor(channel, id)).catch(() => null);
    if (buf) setMemory(key, buf);
    return buf;
  }

  async function set(channel, id, buf) {
    setMemory(keyFor(channel, id), buf);
    await writeFile(fileFor(channel, id), buf).catch(() => {});
  }

  async function cleanup() {
    try {
      const files = await readdir(dir);
      const now = Date.now();
      let removed = 0;
      for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
          const details = await stat(fullPath);
          if (now - details.mtimeMs > maxAgeMs) {
            await unlink(fullPath);
            removed += 1;
          }
        } catch {
          // File vanished or is unreadable; there is nothing useful to prune.
        }
      }
      if (removed) console.log(`[tg-worker] photo cache: pruned ${removed} old file(s)`);
    } catch {
      // Missing/unreadable cache directory is non-fatal; media can be fetched again.
    }
  }

  return { get, set, cleanup };
}
