/*
 * PayStation specifics. The shared behaviour (verification, races, retries,
 * sync) is covered by tests/conformance.test.ts via tests/conformance/paystation.scenario.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type GatewayConfig,
  GatewayError,
  gatewayResponse,
  type Payment,
  PaymentStatus,
  UnsupportedOperationError,
} from '../../src/index.js';
import PayStationScenario, { INITIATE, STATUS } from '../conformance/paystation.scenario.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { customer, get, hit } from '../support/scenario.js';

let current: PayStationScenario | undefined;

afterEach(() => {
  // Every outbound call must hit a stub: an unmatched one hides a wrong URL.
  expect(current?.http.unmatched ?? []).toEqual([]);
  current = undefined;
});

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

/** A booted scenario, with config and route overrides. */
function paystation(options: { config?: Partial<GatewayConfig>; routes?: Routes } = {}): PayStationScenario {
  class Scenario extends PayStationScenario {
    override config(): GatewayConfig {
      return { ...super.config(), ...options.config };
    }

    override routes(): Routes {
      return { ...super.routes(), ...options.routes };
    }
  }

  current = new Scenario().boot();

  return current;
}

/**
 * Initiate normally and answer transaction-status with `status` (a raw HTML
 * body when it is a string, or built from the latest payment by a function).
 */
function paystationStatus(
  status: string | Record<string, unknown> | ((payment: Payment, s: PayStationScenario) => unknown),
  config: Partial<GatewayConfig> = {},
): PayStationScenario {
  const s: PayStationScenario = paystation({
    config,
    routes: {
      [STATUS]: async () => {
        if (typeof status === 'string') {
          return reply(status, 200, { 'content-type': 'text/html' });
        }

        return reply(typeof status === 'function' ? status(latest(s), s) : status);
      },
    },
  });

  return s;
}

function latest(s: PayStationScenario): Payment {
  const payment = [...s.store.payments.values()].at(-1);

  if (!payment) {
    throw new Error('No payment yet');
  }

  return payment;
}

function charge(s: PayStationScenario, amount: number | string = 150): Promise<Payment> {
  return s.pay
    .gateway('paystation')
    .charge({ amount, reference: 'ORD-PS-1', customer: customer(), description: 'Order PS-1' });
}

async function fresh(s: PayStationScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

const callback = (query: Record<string, string>) => get('/bdpaygate/paystation/callback', query);

it('sends credentials as form fields, the attempt id as invoice_number and the merchant reference alongside', async () => {
  const s = paystation();

  const payment = await charge(s, '1250.5');

  expect(payment.checkoutUrl).toMatch(/^https:\/\/sandbox\.paystation\.com\.bd\/checkout\//);
  expect(payment.gatewayReference).toMatch(/^BP/);

  const request = s.http.requests.find((r) => r.url.pathname.endsWith('/initiate-payment'));
  expect(request?.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
  expect(request?.data).toMatchObject({
    merchantId: '104-0000000000',
    password: 'test-store-pass',
    invoice_number: payment.gatewayReference,
    payment_amount: '1250.50',
    currency: 'BDT',
    reference: 'ORD-PS-1',
    opt_a: payment.id,
    cust_phone: '01711000000',
    cust_email: 'rahim@example.com',
  });
  expect(String(request?.data.callback_url)).toMatch(/\/bdpaygate\/paystation\/callback$/);
  expect(request?.data).not.toHaveProperty('pay_with_charge');
});

it('throws on a business error returned with HTTP 200', async () => {
  const s = paystation({
    routes: {
      [INITIATE]: () =>
        reply({ status_code: '1008', status: 'failed', message: 'Duplicate invoice number.' }),
    },
  });

  const error = await rejection(charge(s));
  expect(error).toBeInstanceOf(GatewayError);
  expect(error.message).toContain('Duplicate invoice number. (1008)');

  const [payment] = [...s.store.payments.values()];
  expect(payment && gatewayResponse(payment, 'create')).toMatchObject({ status_code: '1008' });
});

it('throws on a non-JSON response to initiate-payment', async () => {
  const s = paystation({ routes: { [INITIATE]: () => reply('<html>Just a moment...</html>', 403) } });

  const error = await rejection(charge(s));
  expect(error).toBeInstanceOf(GatewayError);
  expect(error.message).toContain('HTTP 403');
});

it('uses the live host when sandbox is off', async () => {
  const s = paystation({
    config: { sandbox: false },
    routes: {
      'api.paystation.com.bd/initiate-payment': () =>
        reply({
          status_code: '200',
          status: 'success',
          payment_url: 'https://api.paystation.com.bd/checkout/1/x',
        }),
    },
  });

  expect((await charge(s)).checkoutUrl).toBe('https://api.paystation.com.bd/checkout/1/x');
});

it('asks transaction-status with the merchantId header and the invoice number, never the password', async () => {
  const s = paystation();
  const payment = await charge(s);

  const response = await hit(
    s.pay,
    callback({ status: 'Successful', invoice_number: payment.gatewayReference }),
  );
  expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);

  const request = s.http.requests.find((r) => r.url.pathname.endsWith('/transaction-status'));
  expect(request?.headers.get('merchantId')).toBe('104-0000000000');
  expect(request?.data.invoice_number).toBe(payment.gatewayReference);
  expect(request?.data).not.toHaveProperty('password');

  expect((await fresh(s, payment)).gatewayTransactionId).toBe(`TRX${payment.gatewayReference.slice(2, 10)}`);
});

describe('reads trx_status in any casing', () => {
  it.each([
    ['Success', PaymentStatus.Completed],
    ['SUCCESS', PaymentStatus.Completed],
    [' success ', PaymentStatus.Completed],
    ['successful', PaymentStatus.Completed], // what the live sandbox actually returns
    ['Successful', PaymentStatus.Completed],
    ['Failed', PaymentStatus.Failed],
    ['FAILED', PaymentStatus.Failed],
    ['Processing', PaymentStatus.Pending],
    ['Refund', PaymentStatus.Pending],
  ])('%j', async (trxStatus, expected) => {
    const s = paystationStatus((p, scenario) => ({
      status_code: '200',
      status: 'success',
      data: scenario.transaction(p, trxStatus),
    }));
    const payment = await charge(s);

    await hit(s.pay, callback({ status: 'Failed', invoice_number: payment.gatewayReference }));

    expect((await fresh(s, payment)).status).toBe(expected);
  });
});

it('marks a verified failure as cancelled when the customer cancelled', async () => {
  const s = paystation();
  s.state = 'failed';
  const payment = await charge(s);

  const response = await hit(
    s.pay,
    callback({ status: 'Canceled', invoice_number: payment.gatewayReference }),
  );

  expect(response.headers.get('location')).toBe(`/cancelled?payment=${payment.id}`);
  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Cancelled);
});

it('trusts the status API over a "Successful" claim in the query string', async () => {
  const s = paystation();
  let completed = 0;
  s.pay.on('payment.completed', () => {
    completed++;
  });
  s.state = 'unpaid';
  const payment = await charge(s);

  const response = await hit(
    s.pay,
    callback({ status: 'Successful', trx_id: 'FORGED', invoice_number: payment.gatewayReference }),
  );

  expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
  const after = await fresh(s, payment);
  expect(after.status).toBe(PaymentStatus.Pending);
  expect(after.gatewayTransactionId).toBeNull();
  expect(completed).toBe(0);
});

describe('keeps the payment pending on a status-API business error', () => {
  it.each([
    ['not found', { status_code: '2001', status: 'failed', message: 'Transaction not found in system' }],
    ['invalid token', { status_code: '2001', status: 'failed', message: 'Invalid Token.' }],
    ['not json', '<html>Just a moment...</html>'],
  ] as const)('%s', async (_name, body) => {
    const s = paystationStatus(body);
    const payment = await charge(s);

    const response = await hit(
      s.pay,
      callback({ status: 'Failed', invoice_number: payment.gatewayReference }),
    );

    expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Pending);
    expect(gatewayResponse(after, 'callback')).not.toBeNull();
  });
});

it('rejects a status response for a different invoice', async () => {
  const s = paystationStatus((p) => ({
    status_code: '200',
    data: { invoice_number: 'BPSOMEONEELSE', trx_status: 'success', payment_amount: p.amount },
  }));
  const payment = await charge(s);

  const response = await hit(
    s.pay,
    callback({ status: 'Successful', invoice_number: payment.gatewayReference }),
  );

  expect(response.headers.get('location')).toBe('/failed');
  expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
});

describe('requires payment_amount to match unless the customer bears the charge', () => {
  it.each([
    ['merchant bears the charge', false, PaymentStatus.Pending],
    ['customer bears the charge', true, PaymentStatus.Completed],
  ] as const)('%s', async (_name, payWithCharge, expected) => {
    const s = paystationStatus(
      (p) => ({
        status_code: '200',
        data: {
          invoice_number: p.gatewayReference,
          trx_status: 'success',
          trx_id: 'T1',
          request_amount: '150.00',
          payment_amount: '152.78',
        },
      }),
      { payWithCharge },
    );
    const payment = await charge(s);

    await hit(s.pay, callback({ status: 'Successful', invoice_number: payment.gatewayReference }));

    expect((await fresh(s, payment)).status).toBe(expected);

    if (payWithCharge) {
      const request = s.http.requests.find((r) => r.url.pathname.endsWith('/initiate-payment'));
      expect(String(request?.data.pay_with_charge)).toBe('1');
    }
  });
});

it('has no refund API', async () => {
  const s = paystation();
  const payment = await charge(s);
  const stored = s.store.payments.get(payment.id);

  if (stored) {
    stored.status = PaymentStatus.Completed;
  }

  expect(s.pay.gateway('paystation').capabilities.refunds).toBe(false);
  await expect(s.pay.refund(await fresh(s, payment))).rejects.toThrow(UnsupportedOperationError);
});
