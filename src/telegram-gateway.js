import { createSerialQueue } from './queue.js';

export function createTelegramGateway({ getClient, onError }) {
  const entityCache = new Map();
  const enqueue = createSerialQueue();

  async function resolve(channel) {
    if (entityCache.has(channel)) return entityCache.get(channel);
    const entity = await getClient().getEntity(channel);
    entityCache.set(channel, entity);
    return entity;
  }

  async function getHistory(channel, { limit, beforeId }) {
    return enqueue(async () => {
      const entity = await resolve(channel);
      return getClient().getMessages(entity, { limit, offsetId: beforeId });
    }).catch((err) => {
      onError?.(err);
      throw err;
    });
  }

  async function getPhoto(channel, id) {
    return enqueue(async () => {
      const client = getClient();
      const entity = await resolve(channel);
      const [message] = await client.getMessages(entity, { ids: [id] });
      if (!message?.photo) return null;
      return client.downloadMedia(message, {});
    }).catch((err) => {
      onError?.(err);
      throw err;
    });
  }

  return { getHistory, getPhoto };
}
