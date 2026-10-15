/**
 * Redis, for tokens and locks shared between processes. Use it whenever you
 * run more than one process: bKash blocks a merchant for an hour after a
 * third token grant within an hour.
 *
 *     import { createClient } from 'redis';
 *     import { redisCache } from 'bdpaygate/cache/redis';
 *     const cache = redisCache(await createClient().connect());
 *
 *     // ioredis:
 *     const cache = ioredisCache(new Redis());
 */
import type { Cache } from '../core/cache.js';

/** node-redis v4/v5 client. */
export interface NodeRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number; NX?: true }): Promise<string | null>;
  del(key: string): Promise<number>;
}

/** ioredis client. */
export interface IoRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', seconds: number, nx?: 'NX'): Promise<'OK' | null>;
  del(key: string): Promise<number>;
}

const ttl = (seconds: number) => Math.max(1, Math.ceil(seconds));

function decode<T>(raw: string | null): T | undefined {
  if (raw === null) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function redisCache(client: NodeRedisLike, prefix = ''): Cache {
  return {
    async get<T>(key: string) {
      return decode<T>(await client.get(prefix + key));
    },
    async set(key, value, seconds) {
      await client.set(prefix + key, JSON.stringify(value), { EX: ttl(seconds) });
    },
    async add(key, value, seconds) {
      return (await client.set(prefix + key, JSON.stringify(value), { EX: ttl(seconds), NX: true })) !== null;
    },
    async delete(key) {
      await client.del(prefix + key);
    },
  };
}

export function ioredisCache(client: IoRedisLike, prefix = ''): Cache {
  return {
    async get<T>(key: string) {
      return decode<T>(await client.get(prefix + key));
    },
    async set(key, value, seconds) {
      await client.set(prefix + key, JSON.stringify(value), 'EX', ttl(seconds));
    },
    async add(key, value, seconds) {
      return (await client.set(prefix + key, JSON.stringify(value), 'EX', ttl(seconds), 'NX')) !== null;
    },
    async delete(key) {
      await client.del(prefix + key);
    },
  };
}
