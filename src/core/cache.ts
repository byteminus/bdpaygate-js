/**
 * Short-lived shared state: access tokens and locks. Gateways like bKash
 * lock a merchant out after a few token grants per hour, so in production
 * with more than one process, use a shared cache (bdpaygate/cache/redis).
 */
export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Set only if the key does not exist. Used for locks. */
  add(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** A cache in this process's memory. Fine for one process; use Redis for several. */
export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);

      return undefined;
    }

    return structuredClone(entry.value) as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async add(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    if ((await this.get(key)) !== undefined) {
      return false;
    }

    await this.set(key, value, ttlSeconds);

    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

export function memoryCache(): MemoryCache {
  return new MemoryCache();
}
