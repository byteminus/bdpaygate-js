/*
 * Moneybag specifics. The shared behaviour (verification, races, retries)
 * is covered by tests/conformance.test.ts via tests/conformance/moneybag.scenario.ts.
 */
import { afterEach, expect, it } from 'vitest';
import {
  type GatewayConfig,
  GatewayError,
  MoneybagGateway,
  type Payment,
  PaymentStatus,
} from '../../src/index.js';
import MoneybagScenario, { VERIFY } from '../conformance/moneybag.scenario.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer, get, hit } from '../support/scenario.js';

let current: MoneybagScenario | undefined;

afterEach(() => {
  // Every outbound call must hit a stub: an unmatched one hides a wrong URL.
  expect(current?.http.unmatched ?? []).toEqual([]);
  current = undefined;
});

function moneybag(options: { config?: Partial<GatewayConfig>; routes?: Routes } = {}): MoneybagScenario {
  class Scenario extends MoneybagScenario {
    override config(): GatewayConfig {
      return { ...super.config(), ...options.config };
    }

    override routes(): Routes {
      return options.routes ?? super.routes();
    }
  }

  current = new Scenario().boot();

  return current;
}

/** One Moneybag verification answer, built from the latest payment, plus a working checkout. */
function moneybagWith(verify: (payment: Payment, s: MoneybagScenario) => Response): MoneybagScenario {
  class Scenario extends MoneybagScenario {
    override routes(): Routes {
      return { ...super.routes(), [VERIFY]: () => verify(latest(this), this) };
    }
  }

  current = new Scenario().boot();

  return current;
}

function latest(s: MoneybagScenario): Payment {
  const payment = [...s.store.payments.values()].at(-1);

  if (!payment) {
    throw new Error('No payment yet');
  }

  return payment;
}

function charge(
  s: MoneybagScenario,
  amount: number,
  reference: string,
  description?: string,
  meta?: Record<string, unknown>,
): Promise<Payment> {
  return s.pay.gateway('moneybag').charge({ amount, reference, customer: customer(), description, meta });
}

async function fresh(s: MoneybagScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );

  if (!(error instanceof Error)) {
    throw new Error('Expected a rejection');
  }

  return error;
}

const callback = (outcome: string, query: Record<string, string>) =>
  get(`/bdpaygate/moneybag/${outcome}`, query);

it('creates a checkout with the merchant key header and the attempt id as order_id', async () => {
  const s = moneybag();

  const payment = await charge(s, 1280, 'ORD-1001', 'Order #1001', { postcode: '1209' });

  expect(payment.gatewayPaymentId).toBe(`ps${payment.gatewayReference}`);
  expect(payment.checkoutUrl).toMatch(/^https:\/\/sandbox\.payment\.moneybag\.com\.bd\//);

  const back = (outcome: string) =>
    `${BASE_URL}/bdpaygate/moneybag/${outcome}?ref=${payment.gatewayReference}`;
  const request = s.http.requests.find(
    (r) => r.url.href === 'https://sandbox.api.moneybag.com.bd/api/v2/payments/checkout',
  );

  expect(request?.headers.get('X-Merchant-API-Key')).toBe('mb-merchant-key');
  expect(request?.data).toMatchObject({
    order_id: payment.gatewayReference,
    order_amount: '1280.00',
    currency: 'BDT',
    order_description: 'Order #1001',
    success_url: back('success'),
    fail_url: back('fail'),
    cancel_url: back('cancel'),
    customer: { postcode: '1209' },
  });
  expect(request?.data.metadata).toEqual({ reference: 'ORD-1001' });
  expect(request?.data).not.toHaveProperty('ipn_url');
});

it('uses the live host when sandbox is off', async () => {
  const s = moneybag({
    config: { sandbox: false },
    routes: {
      'api.moneybag.com.bd/api/v2/payments/checkout': () =>
        reply({
          success: true,
          data: { checkout_url: 'https://pay.example/x', session_id: 's1', expires_at: 'x' },
        }),
    },
  });

  await charge(s, 100, 'ORD-LIVE');

  expect(s.http.requests.map((r) => r.url.href)).toContain(
    'https://api.moneybag.com.bd/api/v2/payments/checkout',
  );
});

it('refuses amounts outside 10 to 1000000 BDT before calling the gateway', async () => {
  const s = moneybag();

  const error = await rejection(charge(s, 5, 'ORD-1002'));

  expect(error).toBeInstanceOf(GatewayError);
  expect(error.message).toContain('10.00 to 1000000.00');
  expect(s.http.requests).toHaveLength(0);
});

it('throws with the validation details when Moneybag refuses the checkout', async () => {
  const s = moneybag({
    routes: {
      'sandbox.api.moneybag.com.bd/*': () =>
        reply(
          {
            detail: [
              {
                loc: ['body', 'customer', 'email'],
                msg: 'value is not a valid email address',
                type: 'value_error',
              },
            ],
          },
          422,
        ),
    },
  });

  const error = await rejection(charge(s, 100, 'ORD-1003'));

  expect(error).toBeInstanceOf(GatewayError);
  expect(error.message).toContain('body.customer.email value is not a valid email address');
});

it('rejects a transaction that belongs to a different order', async () => {
  const s = moneybagWith((p, scenario) => {
    const answer = scenario.verified(p, 'SUCCESS');

    return reply({ ...answer, data: { ...answer.data, order_id: 'SOMEONE-ELSES-ORDER' } });
  });
  const payment = await charge(s, 150, 'ORD-2001');

  const response = await hit(
    s.pay,
    callback('success', { ref: payment.gatewayReference, transaction_id: 'txnOTHER', status: 'SUCCESS' }),
  );

  expect(response.headers.get('location')).toBe('/failed');
  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
});

it('does not complete a SUCCESS that is not verified', async () => {
  const s = moneybagWith((p, scenario) => {
    const answer = scenario.verified(p, 'SUCCESS');

    return reply({ ...answer, data: { ...answer.data, verified: false } });
  });
  const payment = await charge(s, 150, 'ORD-2002');

  const response = await hit(
    s.pay,
    callback('success', { ref: payment.gatewayReference, transaction_id: 'txn1', status: 'SUCCESS' }),
  );

  expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
});

it('stays pending when the verify API does not know the transaction', async () => {
  const s = moneybagWith(() => reply({ detail: 'Transaction not found' }, 404));
  const payment = await charge(s, 150, 'ORD-2003');

  const response = await hit(
    s.pay,
    callback('success', { ref: payment.gatewayReference, transaction_id: 'txnMADEUP', status: 'SUCCESS' }),
  );

  expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
});

it('leaves a cancel without a transaction pending, without calling verify', async () => {
  const s = moneybag();
  const payment = await charge(s, 150, 'ORD-2004');

  const response = await hit(
    s.pay,
    callback('cancel', { ref: payment.gatewayReference, status: 'CANCELLED' }),
  );

  expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  expect(s.http.requests.some((r) => r.url.pathname.includes('/payments/verify/'))).toBe(false);
});

it('marks a verified cancellation cancelled and keeps the transaction id', async () => {
  const s = moneybagWith((p, scenario) => reply(scenario.verified(p, 'CANCELLED')));
  const payment = await charge(s, 150, 'ORD-2005');

  const response = await hit(
    s.pay,
    callback('cancel', {
      ref: payment.gatewayReference,
      transaction_id: `txn${payment.gatewayReference}`,
      status: 'CANCELLED',
    }),
  );

  expect(response.headers.get('location')).toBe(`/cancelled?payment=${payment.id}`);
  const after = await fresh(s, payment);
  expect(after.status).toBe(PaymentStatus.Cancelled);
  expect(after.gatewayTransactionId).toBe(`txn${payment.gatewayReference}`);
});

it('settles a payment from a transaction id found later', async () => {
  const s = moneybag();
  const payment = await charge(s, 150, 'ORD-2006');

  const gateway = s.pay.for(payment);
  expect(gateway).toBeInstanceOf(MoneybagGateway);

  if (!(gateway instanceof MoneybagGateway)) {
    return;
  }

  const settled = await gateway.verifyTransaction(payment, `txn${payment.gatewayReference}`);

  expect(settled.status).toBe(PaymentStatus.Completed);
  expect(settled.gatewayTransactionId).toBe(`txn${payment.gatewayReference}`);
});

it('offers neither refunds nor sync, which the public API does not have', () => {
  const s = moneybag();

  const gateway = s.pay.gateway('moneybag');

  expect(gateway.capabilities.refunds).toBe(false);
  expect(gateway.capabilities.sync).toBe(false);
});
