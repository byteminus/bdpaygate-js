import type { Payment, PaymentStatus } from './types.js';

export interface PendingQuery {
  gateway?: string;
  /** Only payments created at or before this time. */
  createdBefore: Date;
  /** Only payments created at or after this time. */
  createdAfter: Date;
  limit: number;
  /** Newest first instead of oldest first. */
  newestFirst?: boolean;
}

/**
 * Where payments live. Use memoryStore() in tests, or one of the stores in
 * bdpaygate/stores/* (SQL, Prisma, MongoDB), or implement this for your own.
 *
 * Every method must return copies: callers mutate what they get back.
 */
export interface PaymentStore {
  insert(payment: Payment): Promise<void>;

  find(id: string): Promise<Payment | null>;

  /** The payment of a gateway with this gatewayReference or gatewayPaymentId. */
  findBy(
    gateway: string,
    field: 'gatewayReference' | 'gatewayPaymentId',
    value: string,
  ): Promise<Payment | null>;

  /**
   * Write every field of the payment, but only if its stored status is one
   * of `ifStatusIn` (when given). This conditional write is what makes a
   * transition happen once when an IPN and a redirect race: implement it as
   * a single atomic UPDATE ... WHERE status IN (...).
   *
   * @returns whether the row was written.
   */
  update(payment: Payment, ifStatusIn?: readonly PaymentStatus[]): Promise<boolean>;

  /** Every attempt for a reference on a gateway, oldest first. */
  attempts(gateway: string, reference: string): Promise<Payment[]>;

  /** Whether another attempt for this reference is already paid. */
  hasPaidAttempt(gateway: string, reference: string, exceptId?: string): Promise<boolean>;

  /** Pending payments in the window, oldest first (or newest first), at most `limit`. */
  pending(query: PendingQuery): Promise<Payment[]>;
}
