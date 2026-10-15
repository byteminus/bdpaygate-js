import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ioredisCache, redisCache } from '../../src/cache/redis.js';
import { createBdPayGate, MemoryStore, type Payment, type PaymentStore } from '../../src/index.js';
import { type MongoCollectionLike, MongoStore, type PaymentDocument } from '../../src/stores/mongodb.js';
import { type PrismaPaymentDelegate, type PrismaPaymentRow, PrismaStore } from '../../src/stores/prisma.js';
import { createTableSql, fromSqlite, type SqlClient, SqlStore } from '../../src/stores/sql.js';

function payment(overrides: Partial<Payment> = {}): Payment {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);

  return {
    id: `01J${Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(23, '0')}`.slice(0, 26),
    gateway: 'bkash',
    reference: 'ORD-1',
    gatewayReference: `BP${Math.random().toString(36).slice(2, 20).toUpperCase()}`,
    gatewayPaymentId: null,
    gatewayTransactionId: null,
    amount: '150.00',
    refundedAmount: '0.00',
    currency: 'BDT',
    status: 'pending',
    requiresReview: false,
    failureReason: null,
    description: 'Order ১২৩ — ৳',
    checkoutUrl: 'https://pay.example/1',
    customer: {
      name: 'রহিম',
      phone: '01711000000',
      email: null,
      address: null,
      city: 'Dhaka',
      country: 'Bangladesh',
      postcode: null,
      state: null,
    },
    meta: { orderId: 7, tags: ['a'] },
    gatewayResponse: [{ step: 'create', at: now.toISOString(), payload: { ok: true } }],
    paidAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------- in-memory fakes for Mongo and Prisma

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];

    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('$in' in c || 'in' in c) return ((c.$in ?? c.in) as unknown[]).includes(value);
      if ('$ne' in c || 'not' in c) return value !== (c.$ne ?? c.not);
      const v = value as Date;
      if ('$lte' in c || 'lte' in c) if (!(v <= ((c.$lte ?? c.lte) as Date))) return false;
      if ('$gte' in c || 'gte' in c) if (!(v >= ((c.$gte ?? c.gte) as Date))) return false;
      return true;
    }

    return value === cond;
  });
}

function fakeCollection(): MongoCollectionLike {
  const docs = new Map<string, PaymentDocument>();
  const cursor = (items: PaymentDocument[]) => {
    let list = items;
    const c = {
      sort: (spec: Record<string, 1 | -1>) => {
        const [key = 'createdAt', dir = 1] = Object.entries(spec)[0] ?? [];
        const sortValue = (doc: PaymentDocument) => {
          const value: unknown = doc[key as keyof PaymentDocument];
          return value instanceof Date ? value.getTime() : String(value);
        };
        list = [...list].sort((a, b) => (sortValue(a) > sortValue(b) ? dir : -dir));
        return c;
      },
      limit: (n: number) => {
        list = list.slice(0, n);
        return c;
      },
      toArray: async () => list.map((d) => structuredClone(d)),
    };
    return c;
  };

  return {
    insertOne: async (doc) => {
      if (
        [...docs.values()].some(
          (d) => d.gateway === doc.gateway && d.gatewayReference === doc.gatewayReference,
        )
      )
        throw new Error('E11000 duplicate key');
      docs.set(doc._id, structuredClone(doc));
    },
    findOne: async (filter) => structuredClone([...docs.values()].find((d) => matches(d, filter)) ?? null),
    find: (filter) => cursor([...docs.values()].filter((d) => matches(d, filter))),
    updateOne: async (filter, update) => {
      const doc = [...docs.values()].find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0 };
      docs.set(doc._id, { ...doc, ...structuredClone(update.$set) });
      return { matchedCount: 1 };
    },
    createIndex: async () => 'ok',
  };
}

function fakePrisma(): PrismaPaymentDelegate {
  const rows = new Map<string, PrismaPaymentRow>();
  // Prisma returns Decimal objects for decimal columns.
  class Decimal {
    constructor(private readonly value: string) {}
    toString() {
      return this.value;
    }
  }
  const decimal = (v: unknown) => new Decimal(String(v));
  const copy = (r: PrismaPaymentRow): PrismaPaymentRow => ({
    ...r,
    customer: structuredClone(r.customer),
    meta: structuredClone(r.meta),
    gatewayResponse: structuredClone(r.gatewayResponse),
  });
  const plain = (data: Record<string, unknown>) =>
    ({ ...data, amount: undefined, refundedAmount: undefined }) as unknown as PrismaPaymentRow;

  return {
    create: async ({ data }) => {
      rows.set(
        String(data.id),
        copy({ ...plain(data), amount: decimal(data.amount), refundedAmount: decimal(data.refundedAmount) }),
      );
    },
    findUnique: async ({ where }) => {
      const r = rows.get(where.id);
      return r ? copy(r) : null;
    },
    findFirst: async ({ where }) => {
      const r = [...rows.values()].find((row) => matches(row as unknown as Record<string, unknown>, where));
      return r ? copy(r) : null;
    },
    findMany: async ({ where, take, orderBy }) =>
      [...rows.values()]
        .filter((r) => matches(r as unknown as Record<string, unknown>, where))
        .sort(
          (a, b) =>
            ((a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)) *
            (orderBy?.[0]?.createdAt === 'desc' ? -1 : 1),
        )
        .slice(0, take ?? Number.POSITIVE_INFINITY)
        .map(copy),
    updateMany: async ({ where, data }) => {
      const row = [...rows.values()].find((r) => matches(r as unknown as Record<string, unknown>, where));
      if (!row) return { count: 0 };
      rows.set(
        row.id,
        copy({
          ...row,
          ...plain(data),
          amount: decimal(data.amount),
          refundedAmount: decimal(data.refundedAmount),
        }),
      );
      return { count: 1 };
    },
  };
}

async function pglite(): Promise<SqlClient> {
  const db = new PGlite();
  for (const statement of createTableSql('postgres')) await db.exec(statement);

  return {
    async query(sql, params) {
      const result = await db.query<Record<string, unknown>>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
  };
}

// node:sqlite ships with Node 22.5+; on Node 20 the SQL store is covered by PGlite.
const { DatabaseSync } = await import('node:sqlite').catch(() => ({ DatabaseSync: null }));

function sqlite(): SqlClient {
  if (!DatabaseSync) {
    throw new Error('node:sqlite is not available');
  }

  const db = new DatabaseSync(':memory:');
  for (const statement of createTableSql('sqlite')) db.exec(statement);

  return fromSqlite(db);
}

const stores: [string, () => Promise<PaymentStore>][] = [
  ['memory', async () => new MemoryStore()],
  ...(DatabaseSync
    ? [
        ['sql: sqlite (node:sqlite)', async () => new SqlStore({ client: sqlite(), dialect: 'sqlite' })] as [
          string,
          () => Promise<PaymentStore>,
        ],
      ]
    : []),
  ['sql: postgres (PGlite)', async () => new SqlStore({ client: await pglite(), dialect: 'postgres' })],
  ['mongodb', async () => new MongoStore(fakeCollection())],
  ['prisma', async () => new PrismaStore(fakePrisma())],
];

describe.each(stores)('%s store', (_name, make) => {
  it('round-trips every field', async () => {
    const store = await make();
    const p = payment({
      gatewayPaymentId: 'PID-1',
      paidAt: new Date('2026-10-15T08:30:00Z'),
      requiresReview: true,
    });
    await store.insert(p);

    expect(await store.find(p.id)).toEqual(p);
    expect(await store.find('missing')).toBeNull();
  });

  it('finds by gateway reference and gateway payment id, scoped to the gateway', async () => {
    const store = await make();
    const p = payment({ gatewayPaymentId: 'PID-9' });
    await store.insert(p);

    expect((await store.findBy('bkash', 'gatewayReference', p.gatewayReference))?.id).toBe(p.id);
    expect((await store.findBy('bkash', 'gatewayPaymentId', 'PID-9'))?.id).toBe(p.id);
    expect(await store.findBy('nagad', 'gatewayPaymentId', 'PID-9')).toBeNull();
  });

  it('updates only when the stored status is allowed (the race guard)', async () => {
    const store = await make();
    const p = payment();
    await store.insert(p);

    expect(await store.update({ ...p, status: 'completed' }, ['pending', 'failed'])).toBe(true);
    expect(await store.update({ ...p, status: 'failed' }, ['pending'])).toBe(false);
    expect((await store.find(p.id))?.status).toBe('completed');
    expect(await store.update({ ...p, failureReason: 'x' }, [])).toBe(false);
    expect(await store.update({ ...p, status: 'completed', failureReason: 'saved' })).toBe(true);
    expect((await store.find(p.id))?.failureReason).toBe('saved');
  });

  it('lists attempts and knows when a reference is already paid', async () => {
    const store = await make();
    const first = payment({ createdAt: new Date(Date.now() - 60_000) });
    const second = payment({ status: 'completed' });
    await store.insert(first);
    await store.insert(second);

    expect((await store.attempts('bkash', 'ORD-1')).map((a) => a.id)).toEqual([first.id, second.id]);
    expect(await store.hasPaidAttempt('bkash', 'ORD-1')).toBe(true);
    expect(await store.hasPaidAttempt('bkash', 'ORD-1', second.id)).toBe(false);
    expect(await store.hasPaidAttempt('nagad', 'ORD-1')).toBe(false);
  });

  it('lists pending payments in the window, oldest first', async () => {
    const store = await make();
    const now = Date.now();
    const old = payment({ createdAt: new Date(now - 3 * 3600_000) });
    const due = payment({ createdAt: new Date(now - 30 * 60_000) });
    const fresh = payment({ createdAt: new Date(now - 60_000) });
    const done = payment({ createdAt: new Date(now - 30 * 60_000), status: 'completed' });
    const other = payment({ createdAt: new Date(now - 20 * 60_000), gateway: 'nagad' });
    for (const p of [old, due, fresh, done, other]) await store.insert(p);

    const found = await store.pending({
      createdBefore: new Date(now - 15 * 60_000),
      createdAfter: new Date(now - 2 * 3600_000),
      limit: 10,
    });
    expect(found.map((p) => p.id)).toEqual([due.id, other.id]);

    const scoped = await store.pending({
      gateway: 'nagad',
      createdBefore: new Date(now),
      createdAfter: new Date(0),
      limit: 10,
    });
    expect(scoped.map((p) => p.id)).toEqual([other.id]);

    const newest = await store.pending({
      createdBefore: new Date(now),
      createdAfter: new Date(0),
      limit: 2,
      newestFirst: true,
    });
    expect(newest.map((p) => p.id)).toEqual([fresh.id, other.id]);
  });

  it('runs a full payment through the package', async () => {
    const store = await make();
    const pay = createBdPayGate({
      baseUrl: 'https://shop.test',
      gateways: { fake: {} },
      store,
      logger: { warn() {} },
    });
    const fake = pay.fake();
    const charged = await pay.charge({
      amount: 990.5,
      reference: 'ORD-77',
      customer: { name: 'A', phone: '01711000000' },
    });

    await fake.complete(charged);
    await pay.refund(charged, 90.5);

    const stored = await store.find(charged.id);
    expect(stored?.status).toBe('partially_refunded');
    expect(stored?.refundedAmount).toBe('90.50');
    expect(stored?.amount).toBe('990.50');
    await expect(
      pay.charge({ amount: 1, reference: 'ORD-77', customer: { name: 'A', phone: '1' } }),
    ).rejects.toThrow(/already been paid/);
  });
});

describe('redis caches', () => {
  function fakeRedis() {
    const data = new Map<string, { value: string; until: number }>();
    const get = async (key: string) => {
      const entry = data.get(key);
      return entry && entry.until > Date.now() ? entry.value : null;
    };
    const set = async (key: string, value: string, seconds: number, nx: boolean) => {
      if (nx && (await get(key)) !== null) return null;
      data.set(key, { value, until: Date.now() + seconds * 1000 });
      return 'OK' as const;
    };
    return { data, get, set, del: async (key: string) => (data.delete(key) ? 1 : 0) };
  }

  it.each([
    [
      'node-redis',
      (r: ReturnType<typeof fakeRedis>) =>
        redisCache({ get: r.get, del: r.del, set: (k, v, o) => r.set(k, v, o.EX, o.NX === true) }, 'app:'),
    ],
    [
      'ioredis',
      (r: ReturnType<typeof fakeRedis>) =>
        ioredisCache(
          { get: r.get, del: r.del, set: (k, v, _ex, s, nx) => r.set(k, v, s, nx === 'NX') },
          'app:',
        ),
    ],
  ])('%s stores JSON, honours NX and prefixes keys', async (_name, make) => {
    const redis = fakeRedis();
    const cache = make(redis);

    await cache.set('token', { a: 1 }, 60);
    expect(await cache.get('token')).toEqual({ a: 1 });
    expect(redis.data.has('app:token')).toBe(true);
    expect(await cache.add('lock', 'x', 30)).toBe(true);
    expect(await cache.add('lock', 'y', 30)).toBe(false);
    await cache.delete('lock');
    expect(await cache.add('lock', 'z', 30)).toBe(true);
    expect(await cache.get('missing')).toBeUndefined();
  });
});
