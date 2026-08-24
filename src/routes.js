import { createHash } from 'node:crypto';

function extractMessageUrls(message, text, webpage) {
  const urls = [];

  for (const entity of message.entities || []) {
    if (typeof entity.url === 'string') {
      urls.push(entity.url);
      continue;
    }
    if (Number.isInteger(entity.offset) && Number.isInteger(entity.length)) {
      const visible = text.slice(entity.offset, entity.offset + entity.length);
      if (/^https?:\/\//i.test(visible)) urls.push(visible);
    }
  }

  if (typeof webpage?.url === 'string') urls.push(webpage.url);
  for (const row of message.replyMarkup?.rows || []) {
    for (const button of row.buttons || []) {
      if (typeof button.url === 'string') urls.push(button.url);
    }
  }

  return [...new Set(urls.filter((url) => /^https?:\/\//i.test(url)))];
}

function normalizeHistory(messages) {
  const albumPhotoIds = new Map();
  let minId = null;

  for (const message of messages) {
    if (typeof message.id === 'number') {
      minId = minId === null ? message.id : Math.min(minId, message.id);
    }
    const groupId = message.groupedId != null ? String(message.groupedId) : null;
    if (groupId && message.photo) {
      if (!albumPhotoIds.has(groupId)) albumPhotoIds.set(groupId, []);
      albumPhotoIds.get(groupId).push(message.id);
    }
  }
  for (const ids of albumPhotoIds.values()) ids.sort((a, b) => a - b);

  const out = [];
  const seenAlbums = new Set();
  for (const message of messages) {
    const text = message.message || '';
    if (!text) continue;

    const groupId = message.groupedId != null ? String(message.groupedId) : null;
    let photoIds;
    if (groupId) {
      if (seenAlbums.has(groupId)) continue;
      seenAlbums.add(groupId);
      photoIds = albumPhotoIds.get(groupId) ?? (message.photo ? [message.id] : []);
    } else {
      photoIds = message.photo ? [message.id] : [];
    }

    const webpage = message.media?.webpage;
    const preview = webpage && (webpage.title || webpage.description)
      ? [webpage.title, webpage.description].filter(Boolean).join('. ').trim()
      : null;

    out.push({
      id: message.id,
      text,
      date: message.date ? new Date(message.date * 1000).toISOString() : null,
      hasPhoto: photoIds.length > 0,
      photoIds,
      preview,
      urls: extractMessageUrls(message, text, webpage),
    });
  }

  return { messages: out, minId };
}

export function registerRoutes(app, { gateway, photoCache, health }) {
  app.get('/health', (_req, res) => {
    res.json(health());
  });

  async function loadPhoto(channel, id) {
    let buf = await photoCache.get(channel, id);
    if (buf) return buf;

    buf = await gateway.getPhoto(channel, id);
    if (!buf) return null;
    await photoCache.set(channel, id, buf);
    return buf;
  }

  app.get('/photo', async (req, res) => {
    const channel = String(req.query.channel || '').trim();
    const id = Number(req.query.id);
    if (!channel || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'channel and numeric id required' });
    }

    const key = `${channel}/${id}`;
    try {
      const buf = await loadPhoto(channel, id);
      if (!buf) return res.status(404).json({ ok: false, error: 'no photo' });
      res.setHeader('Content-Type', 'image/jpeg');
      res.send(buf);
    } catch (err) {
      const msg = err?.message ?? String(err);
      console.warn(`[tg-worker] photo ${key} failed: ${msg}`);
      res.status(502).json({ ok: false, error: msg });
    }
  });

  // Content-based fingerprint for cross-message dedupe. It deliberately reuses
  // the same photo cache as /photo, so a fingerprint never creates a second
  // media copy or a separate cache hierarchy. SHA-256 is dependency-free and
  // compares the actual JPEG bytes; callers must retain a text/content fallback
  // because a separately recompressed copy of the same image gets a new hash.
  app.get('/photo-fingerprint', async (req, res) => {
    const channel = String(req.query.channel || '').trim();
    const id = Number(req.query.id);
    if (!channel || !Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'channel and numeric id required' });
    }

    const key = `${channel}/${id}`;
    try {
      const buf = await loadPhoto(channel, id);
      if (!buf) return res.status(404).json({ ok: false, error: 'no photo' });
      const fingerprint = createHash('sha256').update(buf).digest('hex');
      res.json({ ok: true, algorithm: 'sha256', fingerprint });
    } catch (err) {
      const msg = err?.message ?? String(err);
      console.warn(`[tg-worker] fingerprint ${key} failed: ${msg}`);
      res.status(502).json({ ok: false, error: msg });
    }
  });

  app.get('/history', async (req, res) => {
    const channel = String(req.query.channel || '').trim();
    if (!channel) return res.status(400).json({ ok: false, error: 'channel required' });

    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const beforeId = Number(req.query.beforeId) || 0;

    try {
      const rawMessages = await gateway.getHistory(channel, { limit, beforeId });
      const normalized = normalizeHistory(rawMessages);
      res.json({ ok: true, ...normalized });
    } catch (err) {
      const msg = err?.message ?? String(err);
      console.warn(`[tg-worker] @${channel} failed: ${msg}`);
      res.status(502).json({ ok: false, error: msg });
    }
  });
}
