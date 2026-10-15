/**
 * MongoDB, with the official driver (or Mongoose's underlying collection).
 *
 *     import { mongoStore } from 'bdpaygate/stores/mongodb';
 *     const store = mongoStore(db.collection('bdpaygate_payments'));
 *     await store.ensureIndexes();
 */
import { toFixed2 } from '../core/payment.js';
import type { PaymentStore, PendingQuery } from '../core/store.js';
import { PAID_STATUSES, type Payment, type PaymentStatus } from '../core/types.js';

type Filter = Record<string, unknown>;

interface Cursor<T> {
  sort(spec: Record<string, 1 | -1>): Cursor<T>;
  limit(n: number): Cursor<T>;
  toArray(): Promise<T[]>;
}

export type PaymentDocument = Omit<Payment, 'id'> & { _id: string };

/** The subset of a MongoDB Collection the store uses. */
export interface MongoCollectionLike {
  insertOne(doc: PaymentDocument): Promise<unknown>;
  findOne(filter: Filter, options?: { projection?: Record<string, 0 | 1> }): Promise<PaymentDocument | null>;
  find(filter: Filter): Cursor<PaymentDocument>;
  updateOne(filter: Filter, update: { $set: Partial<PaymentDocument> }): Promise<{ matchedCount: number }>;
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>;
}

function toPayment(doc: PaymentDocument): Payment {
  const { _id, ...rest } = doc;

  return {
    ...rest,
    id: _id,
    amount: toFixed2(Number(rest.amount)),
    refundedAmount: toFixed2(Number(rest.refundedAmount ?? 0)),
    gatewayResponse: rest.gatewayResponse ?? [],
  };
}

function toDocument(payment: Payment): PaymentDocument {
  const { id, ...rest } = payment;

  return { _id: id, ...structuredClone(rest) };
}

export class MongoStore implements PaymentStore {
  constructor(private readonly collection: MongoCollectionLike) {}

  /** Create the indexes the store relies on. Safe to call on every boot. */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ gateway: 1, gatewayReference: 1 }, { unique: true });
    await this.collection.createIndex({ gateway: 1, gatewayPaymentId: 1 });
    await this.collection.createIndex({ gateway: 1, reference: 1 });
    await this.collection.createIndex({ status: 1, createdAt: 1 });
  }

  async insert(payment: Payment): Promise<void> {
    await this.collection.insertOne(toDocument(payment));
  }

  async find(id: string): Promise<Payment | null> {
    const doc = await this.collection.findOne({ _id: id });

    return doc ? toPayment(doc) : null;
  }

  async findBy(
    gateway: string,
    field: 'gatewayReference' | 'gatewayPaymentId',
    value: string,
  ): Promise<Payment | null> {
    const doc = await this.collection.findOne({ gateway, [field]: value });

    return doc ? toPayment(doc) : null;
  }

  async update(payment: Payment, ifStatusIn?: readonly PaymentStatus[]): Promise<boolean> {
    if (ifStatusIn && ifStatusIn.length === 0) {
      return false;
    }

    const filter: Filter = { _id: payment.id };

    if (ifStatusIn) {
      filter.status = { $in: [...ifStatusIn] };
    }

    const { _id, createdAt: _createdAt, ...set } = toDocument({ ...payment, updatedAt: new Date() });
    const result = await this.collection.updateOne(filter, { $set: set });

    return result.matchedCount > 0;
  }

  async attempts(gateway: string, reference: string): Promise<Payment[]> {
    const docs = await this.collection.find({ gateway, reference }).sort({ createdAt: 1, _id: 1 }).toArray();

    return docs.map(toPayment);
  }

  async hasPaidAttempt(gateway: string, reference: string, exceptId?: string): Promise<boolean> {
    const filter: Filter = { gateway, reference, status: { $in: [...PAID_STATUSES] } };

    if (exceptId !== undefined) {
      filter._id = { $ne: exceptId };
    }

    return (await this.collection.findOne(filter, { projection: { _id: 1 } })) !== null;
  }

  async pending(query: PendingQuery): Promise<Payment[]> {
    const filter: Filter = {
      status: 'pending',
      createdAt: { $lte: query.createdBefore, $gte: query.createdAfter },
    };

    if (query.gateway !== undefined) {
      filter.gateway = query.gateway;
    }

    const docs = await this.collection
      .find(filter)
      .sort({ createdAt: query.newestFirst ? -1 : 1 })
      .limit(query.limit)
      .toArray();

    return docs.map(toPayment);
  }
}

export function mongoStore(collection: MongoCollectionLike): MongoStore {
  return new MongoStore(collection);
}
