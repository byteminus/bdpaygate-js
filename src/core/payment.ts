import { type JsonObject, PAID_STATUSES, type Payment, PaymentStatus } from './types.js';

/** How many gateway responses are kept per payment. */
export const LOG_LIMIT = 50;

export function isPaid(payment: Pick<Payment, 'status'>): boolean {
  return PAID_STATUSES.includes(payment.status);
}

export function isPending(payment: Pick<Payment, 'status'>): boolean {
  return payment.status === PaymentStatus.Pending;
}

export function refundableAmount(payment: Pick<Payment, 'amount' | 'refundedAmount'>): string {
  return toFixed2(Number(payment.amount) - Number(payment.refundedAmount));
}

/**
 * Whether a payment may move from one status to another through a callback
 * or sync. Failed and Cancelled can still become Completed.
 */
export function canMoveTo(from: PaymentStatus, to: PaymentStatus): boolean {
  switch (to) {
    case PaymentStatus.Completed:
      return (
        from === PaymentStatus.Pending || from === PaymentStatus.Failed || from === PaymentStatus.Cancelled
      );
    case PaymentStatus.Failed:
    case PaymentStatus.Cancelled:
      return from === PaymentStatus.Pending;
    default:
      return false;
  }
}

/** Every status a payment can be in for it to move to `to`. */
export function statusesThatCanMoveTo(to: PaymentStatus): PaymentStatus[] {
  return Object.values(PaymentStatus).filter((from) => canMoveTo(from, to));
}

/** Append a gateway payload to the payment's response log (mutates and returns it). */
export function logGatewayResponse(payment: Payment, step: string, payload: JsonObject): Payment {
  payment.gatewayResponse = [
    ...payment.gatewayResponse,
    { step, at: new Date().toISOString(), payload },
  ].slice(-LOG_LIMIT);

  return payment;
}

/** The most recent logged payload for a step, if any. */
export function gatewayResponse(payment: Payment, step: string): JsonObject | null {
  for (let i = payment.gatewayResponse.length - 1; i >= 0; i--) {
    const entry = payment.gatewayResponse[i];

    if (entry?.step === step) {
      return entry.payload;
    }
  }

  return null;
}

/** "1234.5" -> "1234.50", rounding half away from zero like the gateways do. */
export function toFixed2(value: number): string {
  const rounded = Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;

  return (Math.sign(value) < 0 && rounded !== 0 ? -rounded : rounded).toFixed(2);
}
