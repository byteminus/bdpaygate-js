/*
 * UddoktaPay specifics. The shared behaviour (verification, races, retries)
 * is covered by tests/conformance.test.ts via tests/conformance/uddoktapay.scenario.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBdPayGate,
  type GatewayConfig,
  GatewayError,
  gatewayResponse,
  type JsonObject,
  type Payment,
  PaymentStatus,
  UnsupportedOperationError,
} from '../../src/index.js';
import UddoktaPayScenario, { CHECKOUT, invoiceId, VERIFY } from '../conformance/uddoktapay.scenario.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer, get, hit, post } from '../support/scenario.js';

const KEY = 'test-uddoktapay-key';

let current: UddoktaPayScenario | undefined;

afterEach(() => {
  // Every outbound call must hit a stub: an unmatched one hides a wrong URL.
  expect(current?.http.unmatched ?? []).toEqual([]);
  current = undefined;
});

/** A booted scenario. `config` replaces the gateway config entirely when `replace` is set. */
function uddoktapay(
  options: { config?: Partial<GatewayConfig>; replace?: boolean; routes?: Routes } = {},
): UddoktaPayScenario {
  class Scenario extends UddoktaPayScenario {
    override config(): GatewayConfig {
      return options.replace ? { ...options.config } : { ...super.config(), ...options.config };
    }

    override routes(): Routes {
      return options.routes ?? super.routes();
    }
  }

  current = new Scenario().boot();

  return current;
}

function charge(
  s: UddoktaPayScenario,
  amount: number | string = 150,
  reference = 'ORD-UP-1',
): Promise<Payment> {
  return s.pay
    .gateway('uddoktapay')
    .charge({ amount, reference, customer: customer(), description: 'Order UP-1' });
}

function verifyCalls(s: UddoktaPayScenario): number {
  return s.http.requests.filter((r) => r.url.pathname.endsWith('/api/verify-payment')).length;
}

async function fresh(s: UddoktaPayScenario, payment: Payment): Promise<Payment> {
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

/** POST a JSON webhook, with the API key header when given. */
function webhook(s: UddoktaPayScenario, body: JsonObject, key: string | null = KEY): Promise<Response> {
  return s.pay.fetch(
    new Request(new URL('/bdpaygate/uddoktapay/ipn', BASE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'RT-UDDOKTAPAY-API-KEY': key } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

it('creates a checkout-v2 charge with the API key header and our ids in metadata', async () => {
  const s = uddoktapay();

  const payment = await charge(s, '99.9');

  expect(payment.checkoutUrl).toMatch(/^https:\/\/pay\.merchant\.test\/payment\//);
  expect(payment.gatewayPaymentId).toBeNull();

  const request = s.http.requests.find((r) => r.url.href === 'https://pay.merchant.test/api/checkout-v2');
  expect(request?.headers.get('content-type')).toContain('application/json');
  expect(request?.headers.get('RT-UDDOKTAPAY-API-KEY')).toBe(KEY);
  expect(request?.data).toMatchObject({
    amount: '99.90',
    full_name: 'Rahim Uddin',
    email: 'rahim@example.com',
    return_type: 'GET',
  });
  expect(request?.data.metadata).toEqual({
    gateway_reference: payment.gatewayReference,
    reference: 'ORD-UP-1',
    payment_id: payment.id,
  });
  expect(String(request?.data.redirect_url)).toMatch(/\/bdpaygate\/uddoktapay\/success$/);
  expect(String(request?.data.cancel_url)).toMatch(
    new RegExp(`/bdpaygate/uddoktapay/cancel\\?ref=${payment.gatewayReference}$`),
  );
  expect(String(request?.data.webhook_url)).toMatch(/\/bdpaygate\/uddoktapay\/ipn$/);
});

it('requires baseUrl outside the sandbox', async () => {
  const s = uddoktapay({ config: { driver: 'uddoktapay', apiKey: 'k', sandbox: false }, replace: true });

  const error = await rejection(charge(s));

  expect(error).toBeInstanceOf(GatewayError);
  expect(error.message).toContain('Missing [baseUrl]');
  expect(s.http.requests).toHaveLength(0);
});

it('uses the public sandbox host when sandbox is on and no baseUrl is set', async () => {
  const s = uddoktapay({
    config: { driver: 'uddoktapay', apiKey: 'k', sandbox: true },
    replace: true,
    routes: {
      'sandbox.uddoktapay.com/api/checkout-v2': () =>
        reply({
          status: true,
          message: 'Payment Url',
          payment_url: 'https://sandbox.uddoktapay.com/payment/abc',
        }),
    },
  });

  expect((await charge(s)).checkoutUrl).toBe('https://sandbox.uddoktapay.com/payment/abc');
});

describe('accepts a pasted API URL as baseUrl', () => {
  it.each([
    'https://pay.merchant.test/',
    'https://pay.merchant.test/api/checkout-v2',
    'https://pay.merchant.test/api',
  ])('%s', async (baseUrl) => {
    const s = uddoktapay({
      config: { baseUrl },
      routes: {
        'pay.merchant.test/*': () =>
          reply({ status: true, payment_url: 'https://pay.merchant.test/payment/abc' }),
      },
    });

    await charge(s);

    expect(s.http.requests.map((r) => r.url.href)).toContain('https://pay.merchant.test/api/checkout-v2');
  });
});

it('throws with the gateway message when the charge is refused', async () => {
  const s = uddoktapay({
    routes: { 'pay.merchant.test/*': () => reply({ status: false, message: 'Invalid API Key' }) },
  });

  const error = await rejection(charge(s));

  expect(error).toBeInstanceOf(GatewayError);
  expect(error.message).toContain('Invalid API Key');
});

it('only takes BDT', async () => {
  const s = uddoktapay();
  s.pay = createBdPayGate({
    baseUrl: BASE_URL,
    currency: 'USD',
    gateways: { uddoktapay: s.config() },
    store: s.store,
    cache: s.cache,
    fetch: s.http.fetch,
    logger: { warn() {} },
  });

  const error = await rejection(charge(s));

  expect(error).toBeInstanceOf(GatewayError);
  expect(error.message).toContain('BDT only');
});

it('finds the payment from the verified metadata, not the callback', async () => {
  const s = uddoktapay();
  const payment = await charge(s);

  const response = await hit(s.pay, get('/bdpaygate/uddoktapay/success', { invoice_id: invoiceId(payment) }));
  expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);

  const after = await fresh(s, payment);
  expect(after.status).toBe(PaymentStatus.Completed);
  expect(after.gatewayPaymentId).toBe(invoiceId(payment));
  expect(after.gatewayTransactionId).toMatch(/^TESTTRANS/);

  const request = s.http.requests.find((r) => r.url.pathname.endsWith('/api/verify-payment'));
  expect(request?.data.invoice_id).toBe(invoiceId(payment));
  expect(request?.headers.get('RT-UDDOKTAPAY-API-KEY')).toBe(KEY);
});

it('accepts invoice_id as a POST field (return_type POST)', async () => {
  const s = uddoktapay();
  const payment = await charge(s);

  const response = await hit(
    s.pay,
    post('/bdpaygate/uddoktapay/success', { invoice_id: invoiceId(payment) }),
  );

  expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);
});

it('keeps a PENDING invoice pending and settles it on sync', async () => {
  const s = uddoktapay();
  s.state = 'unpaid';
  const payment = await charge(s);

  const response = await hit(s.pay, get('/bdpaygate/uddoktapay/success', { invoice_id: invoiceId(payment) }));
  expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);

  const after = await fresh(s, payment);
  expect(after.status).toBe(PaymentStatus.Pending);
  expect(after.gatewayPaymentId).toBe(invoiceId(payment));

  s.state = 'paid';

  expect((await s.pay.sync(after)).status).toBe(PaymentStatus.Completed);
});

it('does not call the gateway on sync before an invoice exists', async () => {
  const s = uddoktapay();
  const payment = await charge(s);

  expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Pending);
  expect(verifyCalls(s)).toBe(0);
});

it('rejects an invoice UddoktaPay does not know', async () => {
  const s = uddoktapay();
  const payment = await charge(s);

  const unknown = await hit(s.pay, get('/bdpaygate/uddoktapay/success', { invoice_id: 'INV-NOPE' }));
  const missing = await hit(s.pay, get('/bdpaygate/uddoktapay/success'));

  expect(unknown.headers.get('location')).toBe('/failed');
  expect(missing.headers.get('location')).toBe('/failed');
  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
});

it('stays pending when verify-payment answers with a server error', async () => {
  const s = uddoktapay({
    routes: {
      [CHECKOUT]: () => reply({ status: true, payment_url: 'https://pay.merchant.test/payment/x' }),
      [VERIFY]: () => reply('<h1>502 Bad Gateway</h1>', 502),
    },
  });
  const payment = await charge(s);

  const response = await hit(
    s.pay,
    get('/bdpaygate/uddoktapay/success', { invoice_id: `INV-${payment.gatewayReference}` }),
  );

  expect(response.headers.get('location')).toBe('/pending');
  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
});

describe('webhook', () => {
  it.each([
    ['missing', null],
    ['wrong', '982d381360a69d419689740d9f2e26ce36fb7a50'],
  ] as const)(
    'rejects a webhook without our API key, without asking the gateway (%s)',
    async (_name, key) => {
      const s = uddoktapay();
      let completed = 0;
      s.pay.on('payment.completed', () => {
        completed++;
      });
      const payment = await charge(s);

      const response = await webhook(s, s.invoice(payment, 'COMPLETED'), key);

      expect(response.status).toBe(400);
      expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
      expect(verifyCalls(s)).toBe(0);
      expect(completed).toBe(0);
    },
  );

  it('re-verifies a webhook carrying the right key', async () => {
    const s = uddoktapay();
    s.state = 'unpaid';
    const payment = await charge(s);

    // The body says COMPLETED; verify-payment says PENDING. The body loses.
    const first = await webhook(s, s.invoice(payment, 'COMPLETED'));

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, status: 'pending' });
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
    expect(verifyCalls(s)).toBe(1);

    s.state = 'paid';
    const second = await webhook(s, s.invoice(payment, 'COMPLETED'));

    expect(await second.json()).toMatchObject({ ok: true, status: 'completed' });
  });

  it('rejects a verified amount that differs from the order', async () => {
    const s = uddoktapay();
    s.reportedAmount = '15.00';
    const payment = await charge(s);

    const response = await webhook(s, { invoice_id: invoiceId(payment) });

    expect(response.status).toBe(400);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });
});

describe('cancel', () => {
  it('leaves the payment pending when the customer left before paying', async () => {
    const s = uddoktapay();
    const payment = await charge(s);

    const response = await hit(s.pay, get('/bdpaygate/uddoktapay/cancel', { ref: payment.gatewayReference }));

    expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Pending);
    expect(verifyCalls(s)).toBe(0);
    expect(gatewayResponse(after, 'cancel')).not.toBeNull();
  });

  it('completes a cancel for an invoice UddoktaPay says is paid', async () => {
    const s = uddoktapay();
    const payment = await charge(s);
    const stored = s.store.payments.get(payment.id);

    if (stored) {
      stored.gatewayPaymentId = invoiceId(payment);
    }

    const response = await hit(s.pay, get('/bdpaygate/uddoktapay/cancel', { ref: payment.gatewayReference }));

    expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it("rejects a cancel pointing at another payment's invoice", async () => {
    const s = uddoktapay();
    const mine = await charge(s);
    const theirs = await s.pay
      .gateway('uddoktapay')
      .charge({ amount: 150, reference: 'ORD-UP-2', customer: customer() });

    const response = await hit(
      s.pay,
      get('/bdpaygate/uddoktapay/cancel', { ref: mine.gatewayReference, invoice_id: invoiceId(theirs) }),
    );

    expect(response.headers.get('location')).toBe('/failed');
    expect((await fresh(s, mine)).status).toBe(PaymentStatus.Pending);
    expect((await fresh(s, theirs)).status).toBe(PaymentStatus.Pending);
  });

  it('rejects a cancel for an unknown reference', async () => {
    const s = uddoktapay();

    const response = await hit(s.pay, get('/bdpaygate/uddoktapay/cancel', { ref: 'BPNOTOURS' }));

    expect(response.headers.get('location')).toBe('/failed');
  });
});

it("has no refund API (the refund endpoint's response is undocumented)", async () => {
  const s = uddoktapay();
  const payment = await charge(s);
  const stored = s.store.payments.get(payment.id);

  if (stored) {
    stored.status = PaymentStatus.Completed;
  }

  expect(s.pay.gateway('uddoktapay').capabilities.refunds).toBe(false);
  await expect(s.pay.refund(await fresh(s, payment))).rejects.toThrow(UnsupportedOperationError);
});
