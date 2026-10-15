/*
 * ShurjoPay specifics. The shared behaviour (verification, races, retries,
 * sync) is covered by tests/conformance.test.ts via tests/conformance/shurjopay.scenario.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  createBdPayGate,
  GatewayError,
  gatewayResponse,
  type Payment,
  PaymentStatus,
  UnsupportedOperationError,
} from '../../src/index.js';
import ShurjoPayScenario, { spOrderId } from '../conformance/shurjopay.scenario.js';
import { type MockRequest, mockFetch, type Routes, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer, get, hit, post } from '../support/scenario.js';

const TOKEN = 'sandbox.shurjopayment.com/api/get_token';
const SECRET_PAY = 'sandbox.shurjopayment.com/api/secret-pay';
const VERIFICATION = 'sandbox.shurjopayment.com/api/verification';

/** Boot the scenario, with stubs replacing the scenario's for the same URL. */
function shurjopay(overrides: Routes = {}, s = new ShurjoPayScenario(), currency = 'BDT'): ShurjoPayScenario {
  s.http = mockFetch(() => ({ ...s.routes(), ...overrides }));
  s.pay = createBdPayGate({
    baseUrl: BASE_URL,
    gateways: { [s.gateway]: s.config() },
    store: s.store,
    cache: s.cache,
    fetch: s.http.fetch,
    currency,
    logger: { warn() {} },
    redirects: { success: '/paid', failed: '/failed', cancelled: '/cancelled', pending: '/pending' },
  });

  return s;
}

function charge(s: ShurjoPayScenario, reference: string, amount: number | string = 100): Promise<Payment> {
  return s.pay.gateway('shurjopay').charge({ amount, reference, customer: customer() });
}

async function fresh(s: ShurjoPayScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

/** The payment a verification request is about. */
async function about(s: ShurjoPayScenario, r: MockRequest): Promise<Payment> {
  const payment = await s.store.findBy('shurjopay', 'gatewayPaymentId', String(r.data.order_id));

  if (!payment) {
    throw new Error(`no payment for ${String(r.data.order_id)}`);
  }

  return payment;
}

const calls = (s: ShurjoPayScenario, path: string): number =>
  s.http.requests.filter((r) => r.url.pathname === path).length;

const verifications = (s: ShurjoPayScenario): number => calls(s, '/api/verification');

const location = (response: Response): string | null => response.headers.get('location');

describe('shurjopay', () => {
  it('gets a token, then sends the attempt id as order_id with the token, store_id and prefix', async () => {
    const s = shurjopay();

    const payment = await s.pay
      .gateway('shurjopay')
      .charge({ amount: 1500, reference: 'ORD-1001', customer: customer(), description: 'Order #1001' });

    expect(payment.gatewayPaymentId).toBe(spOrderId(payment.gatewayReference));
    expect(payment.checkoutUrl?.startsWith('https://sandbox.securepay.shurjopayment.com/')).toBe(true);

    const token = s.http.requests.find(
      (r) => r.url.href === 'https://sandbox.shurjopayment.com/api/get_token',
    );
    expect(token?.method).toBe('POST');
    expect(token?.data).toMatchObject({ username: 'sp_sandbox', password: 'pyyk97hu&6u6' });

    const pay = s.http.requests.find(
      (r) => r.url.href === 'https://sandbox.shurjopayment.com/api/secret-pay',
    );
    expect(pay?.headers.get('authorization')).toBe('Bearer sandbox-token');
    expect(pay?.headers.get('content-type')).toContain('application/json');
    expect(pay?.data).toMatchObject({
      token: 'sandbox-token',
      store_id: '1',
      prefix: 'sp',
      order_id: payment.gatewayReference,
      amount: '1500.00',
      currency: 'BDT',
      value1: 'ORD-1001',
      customer_email: 'rahim@example.com',
      customer_address: customer().address,
    });
    expect(String(pay?.data.return_url).endsWith('/bdpaygate/shurjopay/success')).toBe(true);
    expect(String(pay?.data.cancel_url).endsWith('/bdpaygate/shurjopay/cancel')).toBe(true);
  });

  it('caches the token across charges and callbacks', async () => {
    const s = shurjopay();

    const first = await charge(s, 'ORD-1');
    await charge(s, 'ORD-2');
    await hit(s.pay, get('/bdpaygate/shurjopay/success', { order_id: first.gatewayPaymentId }));

    expect((await fresh(s, first)).status).toBe(PaymentStatus.Completed);
    expect(calls(s, '/api/get_token')).toBe(1);
  });

  it('fetches a new token and retries once when ShurjoPay answers 1064 Unauthorized', async () => {
    const s = new ShurjoPayScenario();
    let attempts = 0;
    shurjopay(
      {
        [VERIFICATION]: async (r) =>
          ++attempts === 1
            ? reply({ sp_code: '1064', message: 'Unauthorized' })
            : reply([s.verified(await about(s, r))]),
      },
      s,
    );

    const payment = await charge(s, 'ORD-1064');

    const response = await hit(
      s.pay,
      get('/bdpaygate/shurjopay/success', { order_id: payment.gatewayPaymentId }),
    );

    expect(location(response)).toBe(`/paid?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
    expect(calls(s, '/api/get_token')).toBe(2);
    expect(verifications(s)).toBe(2);
  });

  it('leaves the payment pending when the token is rejected twice', async () => {
    const s = shurjopay({ [VERIFICATION]: () => reply({ sp_code: '1064', message: 'Unauthorized' }) });
    const payment = await charge(s, 'ORD-1064B');

    const back = await hit(
      s.pay,
      get('/bdpaygate/shurjopay/success', { order_id: payment.gatewayPaymentId }),
    );
    const ipn = await hit(s.pay, post('/bdpaygate/shurjopay/ipn', { order_id: payment.gatewayPaymentId }));

    expect(location(back)).toBe('/pending');
    expect(ipn.status).toBe(503);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it('treats 1068 "initiated" as not paid yet, even on the cancel return', async () => {
    const s = shurjopay();
    const payment = await charge(s, 'ORD-1068');
    s.state = 'unpaid';

    const response = await hit(
      s.pay,
      get('/bdpaygate/shurjopay/cancel', { order_id: payment.gatewayPaymentId }),
    );

    expect(location(response)).toBe(`/pending?payment=${payment.id}`);

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Pending);
    expect(gatewayResponse(after, 'cancel')?.sp_code).toBe('1068');
  });

  it('fails on 1001 (declined by the bank) and cancels on 1002', async () => {
    const s = new ShurjoPayScenario();
    shurjopay(
      {
        [VERIFICATION]: async (r) => {
          const declined = (await about(s, r)).reference.includes('1001');

          return reply([
            {
              order_id: r.data.order_id,
              sp_code: declined ? 1001 : 1002, // integer, as the docs show it
              sp_message: declined ? 'Bank transaction failed' : 'Cancel',
              amount: '100.0000',
            },
          ]);
        },
      },
      s,
    );
    const declined = await charge(s, 'ORD-1001D');
    const cancelled = await charge(s, 'ORD-1002C');

    const failedBack = await hit(
      s.pay,
      get('/bdpaygate/shurjopay/success', { order_id: declined.gatewayPaymentId }),
    );
    const cancelBack = await hit(
      s.pay,
      get('/bdpaygate/shurjopay/cancel', { order_id: cancelled.gatewayPaymentId }),
    );

    expect(location(failedBack)).toBe(`/failed?payment=${declined.id}`);
    expect(location(cancelBack)).toBe(`/cancelled?payment=${cancelled.id}`);

    const afterDeclined = await fresh(s, declined);
    expect(afterDeclined.status).toBe(PaymentStatus.Failed);
    expect(afterDeclined.failureReason).toBe('1001 Bank transaction failed');
    expect((await fresh(s, cancelled)).status).toBe(PaymentStatus.Cancelled);
  });

  it('accepts a verification answer that is a bare object instead of an array', async () => {
    const s = new ShurjoPayScenario();
    shurjopay({ [VERIFICATION]: async (r) => reply(s.verified(await about(s, r))) }, s);
    const payment = await charge(s, 'ORD-OBJ', 250);

    await hit(s.pay, get('/bdpaygate/shurjopay/success', { order_id: payment.gatewayPaymentId }));

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.gatewayTransactionId).toBe(`BTX${payment.gatewayReference.slice(2, 10)}`);
  });

  it('does not complete when verification is about a different order', async () => {
    const s = new ShurjoPayScenario();
    shurjopay(
      {
        [VERIFICATION]: async (r) =>
          reply([{ ...s.verified(await about(s, r)), customer_order_id: 'BPSOMEONEELSE' }]),
      },
      s,
    );
    let completed = 0;
    s.pay.on('payment.completed', () => {
      completed++;
    });
    const payment = await charge(s, 'ORD-X', 250);

    const response = await hit(
      s.pay,
      get('/bdpaygate/shurjopay/success', { order_id: payment.gatewayPaymentId }),
    );

    expect(location(response)).toBe('/failed');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
    expect(completed).toBe(0);
  });

  it('rejects a currency mismatch in verification', async () => {
    const s = new ShurjoPayScenario();
    shurjopay(
      { [VERIFICATION]: async (r) => reply([{ ...s.verified(await about(s, r)), currency: 'USD' }]) },
      s,
    );
    const payment = await charge(s, 'ORD-CUR', 250);

    await hit(s.pay, get('/bdpaygate/shurjopay/success', { order_id: payment.gatewayPaymentId }));

    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it('throws on an HTTP 200 validation error from secret-pay and keeps the attempt', async () => {
    const s = shurjopay({
      [SECRET_PAY]: () =>
        reply({
          return_url: 'The return url field is required.',
          customer_city: 'The customer city field is required.',
        }),
    });

    await expect(charge(s, 'ORD-VAL')).rejects.toThrow('The return url field is required.');

    const [attempt] = await s.pay.attempts('ORD-VAL', 'shurjopay');
    expect(attempt?.status).toBe(PaymentStatus.Pending);
    expect(attempt?.checkoutUrl).toBeNull();
  });

  it('throws when the token request is refused', async () => {
    const s = shurjopay({ [TOKEN]: () => reply({ sp_code: '1064', message: 'Unauthorized' }) });

    const attempt = charge(s, 'ORD-TOK');

    await expect(attempt).rejects.toThrow(GatewayError);
    await expect(attempt).rejects.toThrow('token request failed: 1064 Unauthorized');
  });

  it('settles an IPN POST', async () => {
    const s = shurjopay();
    const payment = await charge(s, 'ORD-IPN');

    const response = await hit(
      s.pay,
      post('/bdpaygate/shurjopay/ipn', { order_id: payment.gatewayPaymentId }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'completed' });
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('looks callbacks up by sp_order_id, not by the attempt id', async () => {
    const s = shurjopay();
    const payment = await charge(s, 'ORD-LOOK');

    const byReference = await hit(
      s.pay,
      get('/bdpaygate/shurjopay/success', { order_id: payment.gatewayReference }),
    );
    const bare = await hit(s.pay, get('/bdpaygate/shurjopay/success'));

    expect(location(byReference)).toBe('/failed');
    expect(location(bare)).toBe('/failed');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
    expect(verifications(s)).toBe(0);
  });

  it('does not verify again once a payment is paid', async () => {
    const s = shurjopay();
    const payment = await charge(s, 'ORD-ONCE');

    await hit(s.pay, get('/bdpaygate/shurjopay/success', { order_id: payment.gatewayPaymentId }));
    const ipn = await hit(s.pay, post('/bdpaygate/shurjopay/ipn', { order_id: payment.gatewayPaymentId }));

    expect(ipn.status).toBe(200);
    expect(verifications(s)).toBe(1);
  });

  it('refuses currencies other than BDT and USD', async () => {
    const s = shurjopay({}, new ShurjoPayScenario(), 'EUR');

    await expect(charge(s, 'ORD-EUR')).rejects.toThrow('BDT or USD');
  });

  it('has no refund API', async () => {
    const s = shurjopay();
    const payment = await charge(s, 'ORD-REF');

    const refund = s.pay.refund(payment);

    await expect(refund).rejects.toThrow(UnsupportedOperationError);
    await expect(refund).rejects.toThrow('Refund from the merchant panel');
  });
});

describe('client_ip', () => {
  // The live sandbox rejects a payment without client_ip ("Column 'client_ip' cannot be null").
  const sentIp = (s: ShurjoPayScenario) =>
    s.http.requests.find((r) => r.url.pathname === '/api/secret-pay')?.data.client_ip;

  it('sends the customer IP when given', async () => {
    const s = shurjopay();
    await s.pay
      .gateway('shurjopay')
      .charge({ amount: 100, reference: 'IP-1', customer: { ...customer(), ip: '103.4.5.6' } });

    expect(sentIp(s)).toBe('103.4.5.6');
  });

  it('never sends an empty client_ip', async () => {
    const s = shurjopay();
    await charge(s, 'IP-2');

    expect(sentIp(s)).toBe('127.0.0.1');
  });
});
