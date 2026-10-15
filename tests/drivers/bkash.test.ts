/*
 * bKash specifics. The shared behaviour (verification, races, retries,
 * refunds, sync) is covered by tests/conformance.test.ts via tests/conformance/bkash.scenario.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BkashGateway,
  createBdPayGate,
  type GatewayConfig,
  GatewayError,
  GatewayUnavailableError,
  gatewayResponse,
  type JsonObject,
  type Payment,
  PaymentStatus,
} from '../../src/index.js';
import BkashScenario, { created, error, signature, tokenResponse } from '../conformance/bkash.scenario.js';
import { type Handler, type MockRequest, type Routes, reply, timeout } from '../support/mock-fetch.js';
import { BASE_URL, customer, get, hit } from '../support/scenario.js';

const V2 = 'tokenized.sandbox.bka.sh/v2/tokenized-checkout';
const V1 = 'tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout';

let current: BkashScenario | undefined;

afterEach(() => {
  vi.useRealTimers();
  // Every outbound call must hit a stub: an unmatched one hides a wrong URL.
  expect(current?.http.unmatched ?? []).toEqual([]);
  current = undefined;
});

interface Options {
  /** Overrides the scenario's routes; these match first. */
  routes?: Routes;
  /** Use only these routes, none of the scenario's. */
  only?: boolean;
  config?: Partial<GatewayConfig>;
  currency?: string;
}

/** A booted bKash scenario on V2, with route, config and currency overrides. */
function bkash(options: Options = {}): BkashScenario {
  class Scenario extends BkashScenario {
    override config(): GatewayConfig {
      return { ...super.config(), ...options.config };
    }

    override routes(): Routes {
      const overrides = options.routes ?? {};

      if (options.only) {
        return overrides;
      }

      const base = super.routes();

      for (const key of Object.keys(overrides)) {
        delete base[key];
      }

      return { ...overrides, ...base };
    }

    override boot(): this {
      super.boot();

      if (options.currency) {
        this.pay = createBdPayGate({
          baseUrl: BASE_URL,
          gateways: { [this.gateway]: this.config() },
          store: this.store,
          cache: this.cache,
          fetch: this.http.fetch,
          logger: { warn() {} },
          currency: options.currency,
          redirects: { success: '/paid', failed: '/failed', cancelled: '/cancelled', pending: '/pending' },
        });
      }

      return this;
    }
  }

  current = new Scenario().boot();

  return current;
}

/** Answers in turn, repeating the last one. */
function sequence(...handlers: Handler[]): Handler {
  let i = 0;

  return (request: MockRequest) => {
    const handler = handlers[Math.min(i++, handlers.length - 1)];

    if (!handler) {
      throw new Error('Empty sequence');
    }

    return handler(request);
  };
}

/** Freeze Date (only Date: lock sleeps keep working). */
function freeze(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-20T06:00:00Z'));
}

function travel(minutes: number): void {
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const caught = await promise.then(
    () => null,
    (e: unknown) => e,
  );

  if (!(caught instanceof Error)) {
    throw new Error('Expected a rejection');
  }

  return caught;
}

function charge(s: BkashScenario, amount: number | string = 120, reference = 'INV-1'): Promise<Payment> {
  return s.pay.gateway('bkash').charge({ amount, reference, customer: customer(), description: 'Invoice' });
}

function latest(s: BkashScenario): Payment {
  const payment = [...s.store.payments.values()].at(-1);

  if (!payment) {
    throw new Error('No payment yet');
  }

  return payment;
}

async function fresh(s: BkashScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

const returning = (payment: Payment, status = 'success') =>
  get('/bdpaygate/bkash/callback', {
    paymentID: payment.gatewayPaymentId,
    status,
    signature: signature(String(payment.gatewayPaymentId)),
  });

function completed(payment: Payment, extra: JsonObject = {}): JsonObject {
  return {
    paymentId: payment.gatewayPaymentId,
    trxId: 'DIK20PG0H4',
    transactionStatus: 'Completed',
    amount: payment.amount,
    currency: 'BDT',
    intent: 'sale',
    merchantInvoiceNumber: payment.gatewayReference,
    maxRefundableAmount: payment.amount,
    ...extra,
  };
}

/** A completed bKash payment stored directly, as after a Completed execute. */
async function completedPayment(
  s: BkashScenario,
  amount = '500.00',
  executeExtra: JsonObject = {},
): Promise<Payment> {
  const now = new Date();
  const payment: Payment = {
    id: '01KREFUND00000000000000001',
    gateway: 'bkash',
    reference: 'ORD-R1',
    gatewayReference: 'BPREFUND0000000001',
    gatewayPaymentId: 'TR0011REFUND',
    gatewayTransactionId: 'DIK80PG0SO',
    amount,
    refundedAmount: '0.00',
    currency: 'BDT',
    status: PaymentStatus.Completed,
    requiresReview: false,
    failureReason: null,
    description: null,
    checkoutUrl: null,
    customer: null,
    meta: null,
    gatewayResponse: [
      {
        step: 'execute',
        at: now.toISOString(),
        payload: {
          paymentId: 'TR0011REFUND',
          trxId: 'DIK80PG0SO',
          transactionStatus: 'Completed',
          amount,
          maxRefundableAmount: amount,
          ...executeExtra,
        },
      },
    ],
    paidAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await s.store.insert(payment);

  return payment;
}

const sent = (s: BkashScenario, suffix: string): MockRequest[] =>
  s.http.requests.filter((r) => r.url.pathname.endsWith(suffix));

it('creates a v2 payment with the documented headers and body', async () => {
  const s = bkash();

  const payment = await charge(s, 120, 'INV-1');

  expect(payment.status).toBe(PaymentStatus.Pending);
  expect(payment.gatewayPaymentId).toBe(`TR0011${payment.gatewayReference}`);
  expect(payment.checkoutUrl).toContain('sandbox.payment.bkash.com');

  const grant = s.http.requests.find((r) => r.url.href === `https://${V2}/auth/grant-token`);
  expect(grant?.headers.get('username')).toBe('sandboxuser');
  expect(grant?.headers.get('password')).toBe('sandboxpass');
  expect(grant?.data).toEqual({ app_key: 'app-key', app_secret: 'app-secret' });

  const create = s.http.requests.find((r) => r.url.href === `https://${V2}/payment/create`);
  expect(create?.headers.get('Authorization')).toBe('ID-TOKEN');
  expect(create?.headers.get('X-APP-Key')).toBe('app-key');
  expect(create?.data).toEqual({
    payerReference: '01711000000',
    callbackURL: `${BASE_URL}/bdpaygate/bkash/callback`,
    amount: '120.00',
    currency: 'BDT',
    intent: 'sale',
    merchantInvoiceNumber: payment.gatewayReference,
  });
});

it('surfaces the v2 error code when bKash refuses to create a payment', async () => {
  const s = bkash({
    routes: {
      [`${V2}/payment/create`]: () => reply(error('2007', 'Invalid currency.', 'invalid_currency'), 400),
    },
  });

  const caught = await rejection(charge(s));

  expect(caught).toBeInstanceOf(GatewayError);
  expect(caught.message).toContain('2007: Invalid currency.');
});

it('refuses non-BDT payments before calling bKash', async () => {
  const s = bkash({ currency: 'USD' });

  const caught = await rejection(charge(s));

  expect(caught).toBeInstanceOf(GatewayError);
  expect(caught.message).toContain('only accepts BDT');
  expect(s.http.requests).toHaveLength(0);
});

it('strips characters bKash rejects from payerReference', async () => {
  const s = bkash();

  await s.pay
    .gateway('bkash')
    .charge({ amount: 100, reference: 'A<B>&C', customer: { name: 'X', phone: '' } });

  expect(sent(s, '/payment/create')[0]?.data.payerReference).toBe('ABC');
});

it('grants a token once and reuses it from cache', async () => {
  const s = bkash();

  await charge(s, 100, 'INV-1');
  await charge(s, 100, 'INV-2');

  expect(s.http.requests.filter((r) => r.url.pathname.includes('/auth/'))).toHaveLength(1);
});

it('refreshes an expiring token with the refresh token instead of granting again', async () => {
  freeze();
  const s = bkash();
  await charge(s, 100, 'INV-1');

  travel(51);
  await charge(s, 100, 'INV-2');

  const refresh = sent(s, '/auth/refresh-token');
  expect(refresh).toHaveLength(1);
  expect(refresh[0]?.data.refresh_token).toBe('REFRESH-1');
  expect(refresh[0]?.data.app_key).toBe('app-key');
  expect(refresh[0]?.headers.get('username')).toBe('sandboxuser');
  expect(sent(s, '/payment/create').some((r) => r.headers.get('Authorization') === 'ID-TOKEN-2')).toBe(true);
  expect(sent(s, '/auth/grant-token')).toHaveLength(1);
});

it('grants again when bKash refuses the refresh token', async () => {
  freeze();
  const s = bkash({
    routes: {
      [`${V2}/auth/refresh-token`]: () => reply({ statusCode: '9999', statusMessage: 'System error' }),
      [`${V2}/auth/grant-token`]: sequence(
        () => reply(tokenResponse('ID-TOKEN', 'REFRESH-1')),
        () => reply(tokenResponse('ID-TOKEN-3', 'REFRESH-3')),
      ),
    },
  });
  await charge(s, 100, 'INV-1');

  travel(120);
  await charge(s, 100, 'INV-2');

  expect(sent(s, '/payment/create').some((r) => r.headers.get('Authorization') === 'ID-TOKEN-3')).toBe(true);
});

it('drops a rejected token and retries exactly once', async () => {
  const s = bkash({
    routes: {
      [`${V2}/payment/create`]: sequence(
        () => reply({ message: 'Unauthorized' }, 401),
        () => reply(created('ANY', '100.00')),
      ),
    },
  });

  const payment = await charge(s, 100);

  expect(payment.gatewayPaymentId).toBe('TR0011ANY');
  const creates = sent(s, '/payment/create');
  expect(creates).toHaveLength(2);
  expect(creates[0]?.headers.get('Authorization')).toBe('ID-TOKEN');
  expect(creates[1]?.headers.get('Authorization')).toBe('ID-TOKEN-2');
  expect(sent(s, '/auth/refresh-token')).toHaveLength(1);
});

it('does not loop when the fresh token is rejected too', async () => {
  const s = bkash({ routes: { [`${V2}/payment/create`]: () => reply({ message: 'Unauthorized' }, 401) } });

  const caught = await rejection(charge(s));

  expect(caught).toBeInstanceOf(GatewayError);
  expect(caught.message).toContain('HTTP 401');
  expect(sent(s, '/payment/create')).toHaveLength(2);
});

it('never makes a third token call within an hour', async () => {
  const s = bkash({ routes: { [`${V2}/payment/create`]: () => reply({ message: 'Unauthorized' }, 401) } });

  // Grant, then refresh after the 401: two calls this hour.
  expect(await rejection(charge(s, 100, 'INV-1'))).toBeInstanceOf(GatewayError);

  // The next 401 would need a third. Refused locally instead of getting blocked for an hour.
  const caught = await rejection(charge(s, 100, 'INV-2'));
  expect(caught).toBeInstanceOf(GatewayUnavailableError);
  expect(caught.message).toContain('token calls per hour');
  expect(s.http.requests.filter((r) => r.url.pathname.includes('/auth/'))).toHaveLength(2);
});

it('speaks v1.2.0-beta when configured, and refunds through the v2 refund API', async () => {
  const s = bkash({
    only: true,
    config: { version: 'v1.2' },
    routes: {
      [`${V1}/token/grant`]: () => reply(tokenResponse('V1-TOKEN', 'V1-REFRESH')),
      [`${V1}/create`]: ({ data }) =>
        reply({
          statusCode: '0000',
          statusMessage: 'Successful',
          paymentID: 'TR0011V1',
          transactionStatus: 'Initiated',
          bkashURL: 'https://sandbox.payment.bkash.com/?paymentId=TR0011V1&mode=0011&apiVersion=v1.2.0-beta/',
          successCallbackURL: `${String(data.callbackURL)}?paymentID=TR0011V1&status=success&signature=cm8HBfl65A`,
          amount: data.amount,
          currency: 'BDT',
          intent: 'sale',
          merchantInvoiceNumber: data.merchantInvoiceNumber,
        }),
      [`${V1}/execute`]: () =>
        reply({
          statusCode: '0000',
          statusMessage: 'Successful',
          paymentID: 'TR0011V1',
          customerMsisdn: '01770618575',
          trxID: '6H7801QFYM',
          amount: '150.00',
          transactionStatus: 'Completed',
          currency: 'BDT',
          intent: 'sale',
        }),
      [`${V2}/refund/payment/transaction`]: () =>
        reply({
          originalTrxId: '6H7801QFYM',
          refundTrxId: 'RFV1',
          refundTransactionStatus: 'Completed',
          refundAmount: '50.00',
        }),
    },
  });

  const payment = await charge(s, 150);

  const response = await hit(
    s.pay,
    get('/bdpaygate/bkash/callback', { paymentID: 'TR0011V1', status: 'success', signature: 'cm8HBfl65A' }),
  );
  expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);

  const stored = await fresh(s, payment);
  expect(stored.status).toBe(PaymentStatus.Completed);
  expect(stored.gatewayTransactionId).toBe('6H7801QFYM');

  const create = sent(s, '/v1.2.0-beta/tokenized/checkout/create');
  expect(create).toHaveLength(1);
  expect(create[0]?.data.mode).toBe('0011');
  expect(create[0]?.headers.get('Authorization')).toBe('V1-TOKEN');
  expect(sent(s, '/v1.2.0-beta/tokenized/checkout/execute').map((r) => r.data)).toEqual([
    { paymentID: 'TR0011V1' },
  ]);

  const refund = await s.pay.refund(payment, 50, 'Partial');

  expect(refund.accepted).toBe(true);
  expect(refund.refundId).toBe('RFV1');
  const refunds = sent(s, '/v2/tokenized-checkout/refund/payment/transaction');
  expect(refunds).toHaveLength(1);
  expect(refunds[0]?.data.paymentId).toBe('TR0011V1');
  expect(refunds[0]?.data.trxId).toBe('6H7801QFYM');
});

it('reads v1.2.0-beta errors from statusCode and statusMessage', async () => {
  const s = bkash({
    only: true,
    config: { version: 'v1.2' },
    routes: {
      [`${V1}/token/grant`]: () => reply(tokenResponse('V1-TOKEN', 'V1-REFRESH')),
      [`${V1}/create`]: () => reply({ statusCode: '2065', statusMessage: 'Mendatory field missing' }),
    },
  });

  const caught = await rejection(charge(s));

  expect(caught).toBeInstanceOf(GatewayError);
  expect(caught.message).toContain('2065: Mendatory field missing');
});

it('executes on a success callback and records the trxId', async () => {
  const s: BkashScenario = bkash({
    routes: { [`${V2}/payment/execute`]: () => reply(completed(latest(s))) },
  });
  let events = 0;
  s.pay.on('payment.completed', () => {
    events++;
  });
  const payment = await charge(s);

  const response = await hit(s.pay, returning(payment));
  expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);

  const stored = await fresh(s, payment);
  expect(stored.status).toBe(PaymentStatus.Completed);
  expect(stored.gatewayTransactionId).toBe('DIK20PG0H4');
  expect(sent(s, '/payment/execute').map((r) => r.data)).toEqual([{ paymentId: payment.gatewayPaymentId }]);
  expect(events).toBe(1);
});

it('keeps the payment pending on 2056 Invalid Payment State', async () => {
  const s: BkashScenario = bkash({
    routes: {
      [`${V2}/payment/execute`]: () => reply(error('2056', 'Invalid Payment State', 'invalid_payment_state')),
      [`${V2}/query/payment`]: () =>
        reply({ paymentId: latest(s).gatewayPaymentId, transactionStatus: 'Initiated', amount: '120.00' }),
    },
  });
  const payment = await charge(s);

  const response = await hit(s.pay, returning(payment));
  expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);

  const stored = await fresh(s, payment);
  expect(stored.status).toBe(PaymentStatus.Pending);
  expect(gatewayResponse(stored, 'query')?.execute_error).toEqual({
    code: '2056',
    message: 'Invalid Payment State',
  });
});

describe('fails a definite decline and keeps the bKash code', () => {
  it.each([
    ['insufficient balance', '2023', 'Insufficient Balance'],
    ['duplicate', '2029', 'Duplicate for all transactions'],
  ])('%s', async (_name, code, message) => {
    const s: BkashScenario = bkash({
      routes: {
        [`${V2}/payment/execute`]: () => reply(error(code, message)),
        [`${V2}/query/payment`]: () =>
          reply({ paymentId: latest(s).gatewayPaymentId, transactionStatus: 'Initiated', amount: '120.00' }),
      },
    });
    const payment = await charge(s);

    const response = await hit(s.pay, returning(payment));
    expect(response.headers.get('location')).toBe(`/failed?payment=${payment.id}`);

    const stored = await fresh(s, payment);
    expect(stored.status).toBe(PaymentStatus.Failed);
    expect(stored.failureReason).toBe(`${code}: ${message}`);
  });
});

it('queries after an execute timeout and completes if bKash says Completed', async () => {
  const s: BkashScenario = bkash({
    routes: {
      [`${V2}/payment/execute`]: () => timeout(),
      [`${V2}/query/payment`]: () => reply(completed(latest(s))),
    },
  });
  const payment = await charge(s);

  const response = await hit(s.pay, returning(payment));
  expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);

  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
});

it('queries instead of executing a paymentID twice', async () => {
  const s = bkash({
    routes: {
      [`${V2}/payment/execute`]: () => reply(error('2056', 'Invalid Payment State')),
      [`${V2}/query/payment`]: sequence(
        () => reply({ transactionStatus: 'Initiated', amount: '120.00' }),
        () => reply({ transactionStatus: 'Completed', trxId: 'LATE1', amount: '120.00', currency: 'BDT' }),
      ),
    },
  });
  const payment = await charge(s);

  await hit(s.pay, returning(payment));
  await hit(s.pay, returning(payment));

  const stored = await fresh(s, payment);
  expect(stored.status).toBe(PaymentStatus.Completed);
  expect(stored.gatewayTransactionId).toBe('LATE1');
  expect(sent(s, '/payment/execute')).toHaveLength(1);
});

describe('checks cancel and failure callbacks with Query Payment before believing them', () => {
  it.each([
    ['cancel', PaymentStatus.Cancelled],
    ['failure', PaymentStatus.Failed],
  ])('%s', async (status, expected) => {
    const s = bkash({
      routes: { [`${V2}/query/payment`]: () => reply({ transactionStatus: 'Initiated', amount: '120.00' }) },
    });
    const payment = await charge(s);

    await hit(s.pay, returning(payment, status));

    expect((await fresh(s, payment)).status).toBe(expected);
    expect(sent(s, '/query/payment').length).toBeGreaterThan(0);
    expect(sent(s, '/payment/execute')).toHaveLength(0);
  });
});

it('rejects a callback whose signature does not match the one bKash issued', async () => {
  const s = bkash();
  const payment = await charge(s);

  const response = await hit(
    s.pay,
    get('/bdpaygate/bkash/callback', {
      paymentID: payment.gatewayPaymentId,
      status: 'cancel',
      signature: 'forged',
    }),
  );
  expect(response.headers.get('location')).toBe('/failed');

  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  expect(
    s.http.requests.filter(
      (r) => r.url.pathname.includes('/query/payment') || r.url.pathname.includes('/payment/execute'),
    ),
  ).toHaveLength(0);
});

it('flags an execute that completed for a different amount', async () => {
  const s: BkashScenario = bkash({
    routes: { [`${V2}/payment/execute`]: () => reply(completed(latest(s), { amount: '1.00' })) },
  });
  const payment = await charge(s);

  const response = await hit(s.pay, returning(payment));
  expect(response.headers.get('location')).toBe('/failed');

  const stored = await fresh(s, payment);
  expect(stored.status).toBe(PaymentStatus.Pending);
  expect(stored.requiresReview).toBe(true);
});

it('executes on sync when the customer verified but the callback never arrived', async () => {
  const s: BkashScenario = bkash({
    routes: {
      [`${V2}/query/payment`]: () =>
        reply({
          paymentId: latest(s).gatewayPaymentId,
          transactionStatus: 'Initiated',
          verificationStatus: 'Complete',
          amount: '120.00',
        }),
      [`${V2}/payment/execute`]: () => reply(completed(latest(s))),
    },
  });
  const payment = await charge(s);

  expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Completed);
});

it('fails a payment still Initiated after its 24 hour lifetime', async () => {
  freeze();
  const s = bkash({
    routes: {
      [`${V2}/query/payment`]: () =>
        reply({ transactionStatus: 'Initiated', verificationStatus: 'Incomplete', amount: '120.00' }),
    },
  });
  const payment = await charge(s);

  expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Pending);

  travel(25 * 60);

  const synced = await s.pay.sync(payment);
  expect(synced.status).toBe(PaymentStatus.Failed);
  expect(synced.failureReason).toContain('Expired');
});

describe('maps a definite query status on sync', () => {
  it.each([
    ['Cancelled', PaymentStatus.Cancelled],
    ['Failed', PaymentStatus.Failed],
    ['Expired', PaymentStatus.Failed],
  ])('%s', async (state, expected) => {
    const s = bkash({
      routes: { [`${V2}/query/payment`]: () => reply({ transactionStatus: state, amount: '120.00' }) },
    });

    expect((await s.pay.sync(await charge(s))).status).toBe(expected);
  });
});

it('sends partial refunds with the v2 body and counts them', async () => {
  const s = bkash({
    routes: {
      [`${V2}/refund/payment/transaction`]: sequence(
        () =>
          reply({
            originalTrxId: 'DIK80PG0SO',
            refundTrxId: 'DIK50PG0VX',
            refundTransactionStatus: 'Completed',
            refundAmount: '100.00',
          }),
        () =>
          reply({
            originalTrxId: 'DIK80PG0SO',
            refundTrxId: 'DIK90PG0TJ',
            refundTransactionStatus: 'Completed',
            refundAmount: '150.00',
          }),
      ),
    },
  });
  const payment = await completedPayment(s, '500.00');

  const first = await s.pay.refund(payment, 100, 'Damaged item');
  const second = await s.pay.refund(payment, 150, 'Late delivery');

  expect(first.accepted).toBe(true);
  expect(first.pending).toBe(false);
  expect(first.refundId).toBe('DIK50PG0VX');
  expect(second.refundId).toBe('DIK90PG0TJ');

  const stored = await fresh(s, payment);
  expect(stored.status).toBe(PaymentStatus.PartiallyRefunded);
  expect(stored.refundedAmount).toBe('250.00');

  expect(sent(s, '/refund/payment/transaction')[0]?.data).toEqual({
    paymentId: 'TR0011REFUND',
    trxId: 'DIK80PG0SO',
    refundAmount: '100.00',
    sku: 'ORD-R1',
    reason: 'Damaged item',
  });
});

it('records a rejected refund with the bKash code and does not count it', async () => {
  const s = bkash({
    routes: {
      [`${V2}/refund/payment/transaction`]: () =>
        reply(error('2072', 'Refund amount not valid', 'refund_amount_exceed_payment_amount'), 400),
    },
  });
  const payment = await completedPayment(s);

  const result = await s.pay.refund(payment, 100);

  expect(result.accepted).toBe(false);
  expect(result.message).toBe('2072: Refund amount not valid');
  expect((await fresh(s, payment)).refundedAmount).toBe('0.00');
});

it('treats a refund timeout as pending and exposes the refund status', async () => {
  const s = bkash({
    routes: {
      [`${V2}/refund/payment/transaction`]: () => timeout(),
      [`${V2}/refund/payment/status`]: () =>
        reply({
          originalTrxId: 'DIK80PG0SO',
          originalTrxAmount: '500',
          originalTrxCompletedTime: '2026-09-20T14:39:02:266 GMT+0600',
          refundTransactions: [
            {
              refundTrxId: 'DIK50PG0VX',
              refundTransactionStatus: 'Completed',
              refundAmount: '100.00',
              completedTime: '2026-09-20T14:47:02:000',
            },
          ],
        }),
    },
  });
  const payment = await completedPayment(s);

  const result = await s.pay.refund(payment, 100);

  expect(result.accepted).toBe(true);
  expect(result.pending).toBe(true);
  expect(result.message).toContain('refundStatus()');
  expect((await fresh(s, payment)).refundedAmount).toBe('100.00');

  const gateway = s.pay.for(payment);

  if (!(gateway instanceof BkashGateway)) {
    throw new Error('Expected the bKash gateway');
  }

  const status = await gateway.refundStatus(payment);

  expect(status.originalTrxId).toBe('DIK80PG0SO');
  expect(status.refunds).toEqual([
    {
      refundTrxId: 'DIK50PG0VX',
      status: 'Completed',
      amount: '100.00',
      completedAt: '2026-09-20T14:47:02:000',
    },
  ]);
  expect(sent(s, '/refund/payment/status').map((r) => r.data)).toEqual([
    { paymentId: 'TR0011REFUND', trxId: 'DIK80PG0SO' },
  ]);
});

it('caps refunds at maxRefundableAmount when a coupon was applied', async () => {
  const s = bkash();
  const payment = await completedPayment(s, '20.00', { couponAmount: '4.00', maxRefundableAmount: '16.0' });

  const caught = await rejection(s.pay.refund(payment));

  expect(caught).toBeInstanceOf(GatewayError);
  expect(caught.message).toContain('at most 16.00');
  expect(s.http.requests).toHaveLength(0);
});

it('stops at ten refunds per transaction', async () => {
  let n = 0;
  const s = bkash({
    routes: {
      [`${V2}/refund/payment/transaction`]: ({ data }) =>
        reply({
          refundTrxId: `RF${++n}`,
          refundTransactionStatus: 'Completed',
          refundAmount: data.refundAmount,
        }),
    },
  });
  const payment = await completedPayment(s, '500.00');

  for (let i = 0; i < 10; i++) {
    await s.pay.refund(payment, 10);
  }

  const caught = await rejection(s.pay.refund(payment, 10));
  expect(caught).toBeInstanceOf(GatewayError);
  expect(caught.message).toContain('at most 10 refunds');
});
