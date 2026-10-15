/*
 * Upay specifics. The shared behaviour (verification, races, retries, sync,
 * refunds) is covered by tests/conformance.test.ts via tests/conformance/upay.scenario.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBdPayGate,
  type GatewayConfig,
  GatewayError,
  gatewayResponse,
  type Payment,
  PaymentStatus,
  UnsupportedOperationError,
} from '../../src/index.js';
import UpayScenario, { BASE } from '../conformance/upay.scenario.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer, get, hit } from '../support/scenario.js';

let current: UpayScenario | undefined;

afterEach(() => {
  vi.useRealTimers();
  expect(current?.http.unmatched ?? []).toEqual([]);
  current = undefined;
});

/** Boot the simulated Upay. Overrides take precedence over the default routes. */
function upayScenario(config: GatewayConfig = {}, overrides: Routes = {}): UpayScenario {
  const s = new UpayScenario();
  const baseConfig = s.config();
  const baseRoutes = s.routes.bind(s);
  s.config = () => ({ ...baseConfig, ...config });
  s.routes = () => ({
    ...overrides,
    ...Object.fromEntries(Object.entries(baseRoutes()).filter(([k]) => !(k in overrides))),
  });
  current = s.boot();

  return s;
}

function charge(s: UpayScenario, amount: number, reference: string, description?: string) {
  return s.pay.gateway('upay').charge({ amount, reference, customer: customer(), description });
}

async function fresh(s: UpayScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

const count = (s: UpayScenario, part: string): number =>
  s.http.requests.filter((r) => r.url.href.includes(part)).length;

const redirect = (s: UpayScenario, query: string): Promise<Response> =>
  s.pay.fetch(new Request(`${BASE_URL}/bdpaygate/upay/callback?${query}`));

async function upayPaid(s: UpayScenario, reference = 'ORD-PAID'): Promise<Payment> {
  const payment = await charge(s, 150, reference);
  await redirect(
    s,
    new URLSearchParams({
      txn: payment.gatewayReference,
      status: 'success',
      invoice_id: payment.gatewayReference,
    }).toString(),
  );

  const after = await fresh(s, payment);
  expect(after.status).toBe(PaymentStatus.Completed);

  return after;
}

describe('upay', () => {
  it('authorizes, then initiates with txn_id = invoice_id and the UPAY token', async () => {
    const s = upayScenario();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T20:00:00Z'));

    const payment = await charge(s, 150, 'ORD-1', 'Order 1');

    expect(payment.checkoutUrl).toBe(`https://uat-pg.upay.systems/gateway/SESS${payment.gatewayReference}/`);
    expect(payment.gatewayPaymentId).toBe(`01JUPAY${payment.gatewayReference}`);

    const auth = s.http.requests.find(
      (r) => r.url.href === 'https://uat-pg.upay.systems/payment/merchant-auth/',
    );
    expect(auth?.method).toBe('POST');
    expect(auth?.data).toEqual({ merchant_id: '1110101010000001', merchant_key: 'test-merchant-key' });
    expect(auth?.headers.has('authorization')).toBe(false);

    const init = s.http.requests.find(
      (r) => r.url.href === 'https://uat-pg.upay.systems/payment/merchant-payment-init/',
    );
    expect(init?.headers.get('authorization')).toBe('UPAY JWT-TEST-TOKEN');
    expect(init?.data).toMatchObject({
      txn_id: payment.gatewayReference,
      invoice_id: payment.gatewayReference,
      amount: '150.00',
      date: '2026-10-16', // Asia/Dhaka is already the next day
      transaction_currency_code: 'BDT',
      merchant_id: '1110101010000001',
      merchant_name: 'Test Shop',
      merchant_code: '1234',
      merchant_category_code: '5999',
      merchant_mobile: '01700000000',
      merchant_city: 'Dhaka',
      merchant_country_code: 'BD',
    });
    expect(init?.data.additional_info).toEqual({ reference: 'ORD-1', description: 'Order 1' });
    expect(String(init?.data.redirect_url)).toContain(
      `/bdpaygate/upay/callback?txn=${payment.gatewayReference}`,
    );
    expect(init?.data).not.toHaveProperty('merchant_key');
  });

  it('caches the token across calls', async () => {
    const s = upayScenario();

    await charge(s, 100, 'ORD-A');
    await charge(s, 100, 'ORD-B');

    expect(count(s, 'merchant-auth')).toBe(1);
    expect(count(s, 'merchant-payment-init')).toBe(2);
  });

  it('re-authorizes once when the cached token is refused', async () => {
    const tokens = ['OLD-TOKEN', 'NEW-TOKEN'];
    const s: UpayScenario = upayScenario(
      {},
      {
        [`${BASE}/payment/merchant-auth/`]: () => reply({ code: 'MAS2001', data: { token: tokens.shift() } }),
        [`${BASE}/payment/merchant-payment-init/`]: (request) =>
          request.headers.get('authorization') === 'UPAY NEW-TOKEN'
            ? s.initiated(request.data)
            : reply({ code: 'MAF4001', message: 'Invalid token' }, 401),
      },
    );

    const payment = await charge(s, 100, 'ORD-REAUTH');

    expect(payment.checkoutUrl).toBeTruthy();
    expect(count(s, 'merchant-auth')).toBe(2);
  });

  it('throws when authorization fails, without leaking the key', async () => {
    const s = upayScenario(
      {},
      {
        [`${BASE}/payment/merchant-auth/`]: () =>
          reply({ code: 'MAF4003', message: 'Merchant not found' }, 400),
      },
    );

    const error = await charge(s, 100, 'ORD-AUTH').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayError);

    if (error instanceof GatewayError) {
      expect(error.message).toContain('Merchant not found [MAF4003]');
      expect(JSON.stringify(error.response)).not.toContain('test-merchant-key');
    }
  });

  it('surfaces init errors such as a duplicate txn_id', async () => {
    const s = upayScenario(
      {},
      {
        [`${BASE}/payment/merchant-payment-init/`]: () =>
          reply({ code: 'DTP4003', message: 'Duplicate Transaction id provided' }, 400),
      },
    );

    await expect(charge(s, 100, 'ORD-DUP')).rejects.toThrow('Duplicate Transaction id provided [DTP4003]');
  });

  it('queries status by txn_id with a trailing slash', async () => {
    const s = upayScenario();
    const payment = await upayPaid(s);

    expect(
      s.http.requests.some(
        (r) =>
          r.method === 'GET' &&
          r.url.href ===
            `https://uat-pg.upay.systems/payment/single-payment-status/${payment.gatewayReference}/` &&
          r.headers.get('authorization') === 'UPAY JWT-TEST-TOKEN',
      ),
    ).toBe(true);
    expect(payment.gatewayTransactionId).toBe(`01JUPAY${payment.gatewayReference}`);
  });

  it.each([
    ['appended with &', 'txn=REF&status=success&invoice_id=REF'],
    ['appended with a second ?', 'txn=REF?status=success&invoice_id=REF'],
    ['invoice_id only', 'status=success&invoice_id=REF'],
    ['txn only', 'txn=REF'],
  ])('reads the redirect leniently (%s)', async (_label, query) => {
    const s = upayScenario();
    const payment = await charge(s, 150, 'ORD-Q');

    const response = await redirect(s, query.replaceAll('REF', payment.gatewayReference));

    expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('does not believe the redirect status', async () => {
    const s = upayScenario();
    const payment = await charge(s, 150, 'ORD-LIE');
    s.state = 'unpaid';

    const response = await redirect(s, `status=success&invoice_id=${payment.gatewayReference}`);

    expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it('rejects a status response for another txn_id', async () => {
    const s = upayScenario(
      {},
      {
        [`${BASE}/payment/single-payment-status/*`]: () =>
          reply({
            code: 'PS2005',
            data: { txn_id: 'BPSOMEONEELSE0000000', status: 'success', amount: 150.0 },
          }),
      },
    );
    const payment = await charge(s, 150, 'ORD-X');

    const response = await hit(
      s.pay,
      get('/bdpaygate/upay/callback', { invoice_id: payment.gatewayReference }),
    );

    expect(response.headers.get('location')).toBe('/failed');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it.each([
    ['success', PaymentStatus.Completed],
    ['SUCCESS', PaymentStatus.Completed],
    ['failed', PaymentStatus.Failed],
    ['expired', PaymentStatus.Failed],
    ['cancelled', PaymentStatus.Cancelled],
    ['pending', PaymentStatus.Pending],
    ['something-new', PaymentStatus.Pending],
  ])('maps upay status %s to %s', async (status, expected) => {
    const s: UpayScenario = upayScenario(
      {},
      {
        [`${BASE}/payment/single-payment-status/*`]: () => {
          const payment = [...s.store.payments.values()].find((p) => p.gateway === 'upay');

          return reply({
            code: 'PS2005',
            data: { txn_id: payment?.gatewayReference, status, amount: 150.0 },
          });
        },
      },
    );
    const payment = await charge(s, 150, 'ORD-MAP');

    expect((await s.pay.sync(payment)).status).toBe(expected);
  });

  it('stays pending when upay does not know the payment (PNF4012)', async () => {
    const s = upayScenario(
      {},
      {
        [`${BASE}/payment/single-payment-status/*`]: () =>
          reply({ code: 'PNF4012', message: 'Payment not found' }, 404),
      },
    );
    const payment = await charge(s, 150, 'ORD-404');

    expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Pending);
    expect(gatewayResponse(await fresh(s, payment), 'sync')).toMatchObject({ code: 'PNF4012' });
  });

  it('refunds the full amount through the bulk endpoint', async () => {
    const s = upayScenario();
    let processed = 0;
    s.pay.on('refund.processed', () => {
      processed++;
    });
    const payment = await upayPaid(s);

    const result = await s.pay.refund(payment, null, 'Customer request');

    expect(result.accepted).toBe(true);
    expect(result.pending).toBe(false);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Refunded);
    expect(
      s.http.requests.some(
        (r) =>
          r.url.href === 'https://uat-pg.upay.systems/payment/bulk/refund/' &&
          r.method === 'POST' &&
          r.headers.get('authorization') === 'UPAY JWT-TEST-TOKEN' &&
          r.text === JSON.stringify([{ txn_id: payment.gatewayReference, refund_amount: '150.00' }]),
      ),
    ).toBe(true);
    expect(processed).toBe(1);
  });

  it('treats an "under process" refund as accepted and pending', async () => {
    const s = upayScenario();
    s.refund = 'under_process';
    const payment = await upayPaid(s);

    const result = await s.pay.refund(payment);

    expect(result.accepted).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.message).toContain('under process');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Refunded);
  });

  it('reports a rejected refund without touching the payment', async () => {
    const s = upayScenario();
    s.refund = 'rejected';
    const payment = await upayPaid(s);

    const result = await s.pay.refund(payment);
    const after = await fresh(s, payment);

    expect(result.accepted).toBe(false);
    expect(result.message).toBe('Invalid amount');
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.refundedAmount).toBe('0.00');
  });

  it('only refunds the full amount', async () => {
    const s = upayScenario();
    const payment = await upayPaid(s);

    expect(s.pay.gateway('upay').capabilities.refunds).toBe('full');
    await expect(s.pay.refund(payment, '50.00')).rejects.toThrow(UnsupportedOperationError);
    expect(count(s, 'refund')).toBe(0);
  });

  it('uses the live host and baseUrl override', async () => {
    const live = upayScenario({ sandbox: false }, { 'pg.upaysystem.com/*': () => reply({ code: 'X' }, 500) });
    await expect(charge(live, 100, 'ORD-LIVE')).rejects.toThrow(GatewayError);
    expect(
      live.http.requests.some((r) => r.url.href === 'https://pg.upaysystem.com/payment/merchant-auth/'),
    ).toBe(true);

    const proxied = upayScenario(
      { baseUrl: 'https://upay.proxy.test/' },
      { 'upay.proxy.test/*': () => reply({ code: 'X' }, 500) },
    );
    await expect(charge(proxied, 100, 'ORD-PROXY')).rejects.toThrow(GatewayError);
    expect(
      proxied.http.requests.some((r) => r.url.href === 'https://upay.proxy.test/payment/merchant-auth/'),
    ).toBe(true);
  });

  it('refuses non-BDT charges', async () => {
    const s = upayScenario();
    const pay = createBdPayGate({
      baseUrl: BASE_URL,
      gateways: { upay: s.config() },
      store: s.store,
      cache: s.cache,
      fetch: s.http.fetch,
      logger: { warn() {} },
      currency: 'USD',
    });

    await expect(
      pay.gateway('upay').charge({ amount: 100, reference: 'ORD-USD', customer: customer() }),
    ).rejects.toThrow(/only accepts BDT/);
  });
});
