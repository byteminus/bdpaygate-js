import { isPaid } from '../core/payment.js';
import type { PaymentStore, PendingQuery } from '../core/store.js';
import type { Payment, PaymentStatus } from '../core/types.js';

const copy = (payment: Payment): Payment => structuredClone(payment);

/**
 * Keeps payments in this process. For tests and local development: it is
 * lost on restart and not shared between processes.
 */
export class MemoryStore implements PaymentStore {
  readonly payments = new Map<string, Payment>();

  async insert(payment: Payment): Promise<void> {
    this.payments.set(payment.id, copy(payment));
  }

  async find(id: string): Promise<Payment | null> {
    const payment = this.payments.get(id);

    return payment ? copy(payment) : null;
  }

  async findBy(
    gateway: string,
    field: 'gatewayReference' | 'gatewayPaymentId',
    value: string,
  ): Promise<Payment | null> {
    for (const payment of this.payments.values()) {
      if (payment.gateway === gateway && payment[field] === value) {
        return copy(payment);
      }
    }

    return null;
  }

  async update(payment: Payment, ifStatusIn?: readonly PaymentStatus[]): Promise<boolean> {
    const stored = this.payments.get(payment.id);

    if (!stored || (ifStatusIn && !ifStatusIn.includes(stored.status))) {
      return false;
    }

    this.payments.set(payment.id, { ...copy(payment), updatedAt: new Date() });

    return true;
  }

  async attempts(gateway: string, reference: string): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter((p) => p.gateway === gateway && p.reference === reference)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map(copy);
  }

  async hasPaidAttempt(gateway: string, reference: string, exceptId?: string): Promise<boolean> {
    for (const p of this.payments.values()) {
      if (p.gateway === gateway && p.reference === reference && p.id !== exceptId && isPaid(p)) {
        return true;
      }
    }

    return false;
  }

  async pending(query: PendingQuery): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter(
        (p) =>
          p.status === 'pending' &&
          (query.gateway === undefined || p.gateway === query.gateway) &&
          p.createdAt <= query.createdBefore &&
          p.createdAt >= query.createdAfter,
      )
      .sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * (query.newestFirst ? -1 : 1))
      .slice(0, query.limit)
      .map(copy);
  }

  /** Remove everything (between tests). */
  clear(): void {
    this.payments.clear();
  }
}

export function memoryStore(): MemoryStore {
  return new MemoryStore();
}
