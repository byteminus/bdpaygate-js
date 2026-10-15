/**
 * Where a payment attempt stands.
 *
 * Pending can become anything. Failed and Cancelled are not dead ends: when
 * the gateway later confirms the money moved (a late IPN, a sync), the payment
 * becomes Completed. Nothing leaves a paid state through a callback.
 */
export const PaymentStatus = {
  Pending: 'pending',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  PartiallyRefunded: 'partially_refunded',
  Refunded: 'refunded',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PAID_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.Completed,
  PaymentStatus.PartiallyRefunded,
  PaymentStatus.Refunded,
];

/** The URL segment a gateway calls back on: /bdpaygate/{gateway}/{outcome}. */
export type Outcome = 'success' | 'fail' | 'cancel' | 'ipn' | 'callback';

export const OUTCOMES: readonly Outcome[] = ['success', 'fail', 'cancel', 'ipn', 'callback'];

export interface Customer {
  name: string;
  phone: string;
  email?: string | null;
  address?: string | null;
  /** Defaults to Dhaka. */
  city?: string;
  /** Defaults to Bangladesh. */
  country?: string;
  postcode?: string | null;
  state?: string | null;
  /**
   * The customer's IP address. ShurjoPay requires one, and Nagad and EPS ask
   * for it. Pass the IP of the request that started checkout.
   */
  ip?: string | null;
}

/** A customer with every default applied, as stored on the payment. */
export interface StoredCustomer {
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  city: string;
  country: string;
  postcode: string | null;
  state: string | null;
  ip?: string | null;
}

export type JsonObject = Record<string, unknown>;

export interface GatewayResponseEntry {
  step: string;
  /** ISO 8601. */
  at: string;
  payload: JsonObject;
}

/**
 * One attempt to collect a payment for your reference. Charging the same
 * reference again creates another attempt with a fresh gatewayReference.
 */
export interface Payment {
  id: string;
  /** The gateway name it was charged through (a config key, e.g. "bkash"). */
  gateway: string;
  /** Your order or invoice id. */
  reference: string;
  /** The unique id this attempt was sent to the gateway with. */
  gatewayReference: string;
  gatewayPaymentId: string | null;
  gatewayTransactionId: string | null;
  /** Always two decimals, e.g. "150.00". */
  amount: string;
  refundedAmount: string;
  currency: string;
  status: PaymentStatus;
  /** The gateway flagged the payment (e.g. SSLCommerz risk_level=1). Hold delivery until checked. */
  requiresReview: boolean;
  failureReason: string | null;
  description: string | null;
  checkoutUrl: string | null;
  customer: StoredCustomer | null;
  meta: JsonObject | null;
  /** The last 50 gateway responses, oldest first. */
  gatewayResponse: GatewayResponseEntry[];
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChargeOptions {
  amount: number | string;
  /** Your order id, 1 to 64 characters. */
  reference: string;
  customer: Customer;
  description?: string | null;
  meta?: JsonObject;
}

/** What a gateway concluded about an incoming callback, after verification. */
export interface CallbackResult {
  payment: Payment;
  status: PaymentStatus;
  /** False when the callback changed nothing (a replay, or still pending). */
  changed: boolean;
}

export interface RefundResult {
  payment: Payment;
  /** The gateway took the refund. It counts against the refundable amount. */
  accepted: boolean;
  /** Accepted but processed asynchronously: the money has not necessarily moved yet. */
  pending: boolean;
  amount: string;
  refundId: string | null;
  message: string | null;
  raw: JsonObject;
}

export interface Capabilities {
  /** The gateway can be asked for the current state of a payment. */
  sync: boolean;
  /** False when refunds happen only in the merchant panel. */
  refunds: false | 'full' | 'partial';
}

export interface Logger {
  warn(message: string, context?: JsonObject): void;
}
