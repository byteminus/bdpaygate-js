/*
 * PortPos specifics. The shared behaviour (verification, races, retries,
 * refunds, sync) is covered by tests/conformance.test.ts via tests/conformance/portpos.scenario.ts.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChargeOptions,
  type GatewayConfig,
  gatewayResponse,
  type Payment,
  PaymentStatus,
  PortPosGateway,
} from '../../src/index.js';
import PortPosScenario from '../conformance/portpos.scenario.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer, get, hit, post } from '../support/scenario.js';

let current: PortPosScenario | undefined;

afterEach(() => {
  vi.useRealTimers();
  expect(current?.http.unmatched ?? []).toEqual([]);
  current = undefined;
});

/** Boot the simulated PortPos, with optional config and route overrides (overrides win). */
function portpos(config: GatewayConfig = {}, overrides: Routes = {}): PortPosScenario {
  const s = new PortPosScenario();
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

/** One PortPos invoice validation answer, plus a working create. */
function portposWith(validate: (payment: Payment) => Response): PortPosScenario {
  const s = new PortPosScenario();
  s.routes = () => ({
    'api-sandbox.portpos.com/payment/v2/invoice/ipn/*': () => validate(latest(s)),
    'api-sandbox.portpos.com/payment/v2/invoice': (request) => s.created(request.data),
  });
  current = s.boot();

  return s;
}

function latest(s: PortPosScenario): Payment {
  const payment = [...s.store.payments.values()].filter((p) => p.gateway === 'portpos').at(-1);

  if (!payment) {
    throw new Error('No PortPos payment yet');
  }

  return payment;
}

function charge(s: PortPosScenario, amount: number, reference: string, extra: Partial<ChargeOptions> = {}) {
  return s.pay.gateway('portpos').charge({ amount, reference, customer: customer(), ...extra });
}

async function fresh(s: PortPosScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

describe('portpos', () => {
  it('creates an invoice with a per-request bearer token and the attempt id as reference', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T06:00:00Z'));
    const s = portpos();

    const payment = await charge(s, 1500, 'ORD-1001', {
      description: 'Order #1001',
      meta: { zipcode: '1209' },
    });

    expect(payment.gatewayPaymentId).toBe(`PP${payment.gatewayReference}`);
    expect(payment.checkoutUrl).toBe(`https://ppv2.portpos.com/v2/invoice/PP${payment.gatewayReference}`);

    const hash = createHash('md5')
      .update(`pp-secret-key${Math.floor(Date.now() / 1000)}`)
      .digest('hex');
    const expected = `Bearer ${Buffer.from(`pp-app-key:${hash}`).toString('base64')}`;
    const request = s.http.requests.find(
      (r) => r.url.href === 'https://api-sandbox.portpos.com/payment/v2/invoice',
    );

    expect(request?.method).toBe('POST');
    expect(request?.headers.get('authorization')).toBe(expected);
    expect(request?.data).toMatchObject({
      order: {
        amount: '1500.00',
        currency: 'BDT',
        reference: payment.gatewayReference,
        redirect_url: `${BASE_URL}/bdpaygate/portpos/callback?ref=${payment.gatewayReference}`,
        ipn_url: `${BASE_URL}/bdpaygate/portpos/ipn?ref=${payment.gatewayReference}`,
      },
      product: { name: 'Order #1001' },
      billing: {
        customer: {
          email: 'rahim@example.com',
          address: { street: 'House 1, Road 2', zipcode: '1209', country: 'BD' },
        },
      },
    });
  });

  it('uses the live hosts when sandbox is off', async () => {
    const s = portpos(
      { sandbox: false },
      {
        'api.portpos.com/payment/v2/invoice': () =>
          reply({ result: 'success', data: { invoice_id: 'INV1' } }, 201),
      },
    );

    const payment = await charge(s, 100, 'ORD-LIVE');

    expect(payment.checkoutUrl).toBe('https://payment.portpos.com/v2/invoice/INV1');
    expect(s.http.requests.some((r) => r.url.href.startsWith('https://api.portpos.com/'))).toBe(true);
  });

  it('throws with the error explanation when PortPos refuses the invoice', async () => {
    const s = portpos(
      {},
      {
        'api-sandbox.portpos.com/*': () =>
          reply(
            {
              result: 'ERROR',
              error: {
                cause: 'Validation',
                explanation: 'Phone number is invalid',
                property: 'billing.customer.phone',
              },
            },
            400,
          ),
      },
    );

    await expect(charge(s, 100, 'ORD-1002')).rejects.toThrow(
      'Phone number is invalid (billing.customer.phone)',
    );
  });

  it('refuses a country it cannot express as an ISO code before calling the gateway', async () => {
    const s = portpos();

    await expect(
      s.pay.gateway('portpos').charge({
        amount: 100,
        reference: 'ORD-1003',
        customer: { name: 'Jane', phone: '01711000000', email: 'j@example.com', country: 'Narnia' },
      }),
    ).rejects.toThrow(/ISO 3166/);
    expect(s.http.requests).toEqual([]);
  });

  it('validates with the stored invoice id and amount, never the ones posted', async () => {
    const s = portpos();
    const payment = await charge(s, 150, 'ORD-2001');

    const response = await hit(
      s.pay,
      post(`/bdpaygate/portpos/ipn?ref=${payment.gatewayReference}`, {
        invoice: 'SOMEONE-ELSES',
        amount: '1.00',
        status: 'ACCEPTED',
        reference: payment.gatewayReference,
      }),
    );

    expect(response.status).toBe(200);

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.gatewayTransactionId).toBe(`AC${payment.gatewayReference.slice(2, 10)}`);
    expect(
      s.http.requests.some(
        (r) =>
          r.url.href ===
          `https://api-sandbox.portpos.com/payment/v2/invoice/ipn/PP${payment.gatewayReference}/150.00`,
      ),
    ).toBe(true);
  });

  it('finds the payment from an IPN body when the ref query is missing', async () => {
    const s = portpos();
    const payment = await charge(s, 150, 'ORD-2002');

    const response = await hit(
      s.pay,
      post('/bdpaygate/portpos/ipn', {
        invoice: payment.gatewayPaymentId,
        amount: '150.00',
        status: 'ACCEPTED',
      }),
    );

    expect(response.status).toBe(200);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('marks an expired invoice failed', async () => {
    const s = portposWith((p) => reply(new PortPosScenario().invoice(p, 'EXPIRED')));
    const payment = await charge(s, 150, 'ORD-3001');

    const response = await hit(s.pay, get('/bdpaygate/portpos/callback', { ref: payment.gatewayReference }));

    expect(response.headers.get('location')).toBe(`/failed?payment=${payment.id}`);

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Failed);
    expect(after.failureReason).toBe('Invoice expired');
  });

  it('stays pending when the validation API answers with an error', async () => {
    const s = portposWith(() =>
      reply({ result: 'ERROR', error: { cause: 'Unauthorized', explanation: 'Invalid token' } }, 401),
    );
    let completed = 0;
    s.pay.on('payment.completed', () => {
      completed++;
    });
    const payment = await charge(s, 150, 'ORD-3002');

    const response = await hit(s.pay, get('/bdpaygate/portpos/callback', { ref: payment.gatewayReference }));

    expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Pending);
    expect(gatewayResponse(after, 'callback')).toMatchObject({ result: 'ERROR' });
    expect(completed).toBe(0);
  });

  it('rejects a validation answer for a different invoice', async () => {
    const s = portposWith((p) => {
      const invoice = new PortPosScenario().invoice(p, 'ACCEPTED');

      return reply({ ...invoice, data: { ...(invoice.data as object), invoice_id: 'OTHER' } });
    });
    const payment = await charge(s, 150, 'ORD-3003');

    const response = await hit(s.pay, post(`/bdpaygate/portpos/ipn?ref=${payment.gatewayReference}`));

    expect(response.status).toBe(400);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it('records an accepted refund as pending, without a refund id', async () => {
    const s = portpos();
    const payment = await charge(s, 150, 'ORD-4001');
    await hit(s.pay, get('/bdpaygate/portpos/callback', { ref: payment.gatewayReference }));

    const result = await s.pay.refund(await fresh(s, payment), 40);

    expect(result.accepted).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.refundId).toBeNull();
    expect(result.message).toBe('REFUND_PENDING');
    expect((await fresh(s, payment)).refundedAmount).toBe('40.00');
    expect(
      s.http.requests.some(
        (r) =>
          r.url.href ===
            `https://api-sandbox.portpos.com/payment/v2/invoice/refund/${payment.gatewayPaymentId}` &&
          JSON.stringify(r.data.refund) === JSON.stringify({ amount: '40.00', currency: 'BDT' }),
      ),
    ).toBe(true);
  });

  it('does not count a refused refund', async () => {
    const s = portpos(
      {},
      {
        'api-sandbox.portpos.com/payment/v2/invoice/refund/*': () =>
          reply(
            { result: 'ERROR', error: { cause: 'Refund', explanation: 'Maximum refund attempts exceeded' } },
            400,
          ),
      },
    );
    const payment = await charge(s, 150, 'ORD-4002');
    await hit(s.pay, get('/bdpaygate/portpos/callback', { ref: payment.gatewayReference }));

    const result = await s.pay.refund(await fresh(s, payment), 40);
    const after = await fresh(s, payment);

    expect(result.accepted).toBe(false);
    expect(result.message).toBe('Maximum refund attempts exceeded');
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.refundedAmount).toBe('0.00');
  });

  it('reads the invoice state as the refund status', async () => {
    const s = portpos();
    const payment = await charge(s, 150, 'ORD-4003');

    s.routes = () => ({
      'api-sandbox.portpos.com/payment/v2/invoice/': () =>
        reply({ result: 'success', data: { order: { status: 'REFUND_PROCESSING' } } }),
    });

    const gateway = s.pay.for(payment);

    expect(gateway).toBeInstanceOf(PortPosGateway);

    if (gateway instanceof PortPosGateway) {
      expect(await gateway.refundStatus(payment)).toBe('refund_processing');
    }
  });
});
