/*
 * aamarPay specifics. The shared behaviour (verification, races, retries,
 * sync) is covered by tests/conformance.test.ts via tests/conformance/aamarpay.scenario.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  createBdPayGate,
  GatewayError,
  gatewayResponse,
  type JsonObject,
  type Payment,
  PaymentStatus,
  UnsupportedOperationError,
} from '../../src/index.js';
import AamarPayScenario, { pgTxnId } from '../conformance/aamarpay.scenario.js';
import { type MockRequest, mockFetch, type Routes, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer, get, hit, post } from '../support/scenario.js';

const INIT = 'sandbox.aamarpay.com/jsonpost.php';
const SEARCH = 'sandbox.aamarpay.com/api/v1/trxcheck/request.php';

/** Boot the scenario, with stubs replacing the scenario's for the same URL. */
function aamarpay(overrides: Routes = {}, s = new AamarPayScenario(), currency = 'BDT'): AamarPayScenario {
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

/** A Search Transaction answer for the tran_id in this request, with changes. */
async function searched(s: AamarPayScenario, r: MockRequest, changes: JsonObject = {}): Promise<Response> {
  const payment = await s.store.findBy('aamarpay', 'gatewayReference', String(r.data.request_id));

  if (!payment) {
    throw new Error(`no payment for ${String(r.data.request_id)}`);
  }

  return reply({ ...s.searched(payment), ...changes });
}

function charge(s: AamarPayScenario, reference: string, amount: number | string = 150): Promise<Payment> {
  return s.pay.gateway('aamarpay').charge({ amount, reference, customer: customer() });
}

async function fresh(s: AamarPayScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

const searches = (s: AamarPayScenario): number =>
  s.http.requests.filter((r) => r.url.pathname.includes('/api/v1/trxcheck/request.php')).length;

const location = (response: Response): string | null => response.headers.get('location');

describe('aamarpay', () => {
  it('posts JSON with the attempt id as tran_id and stores the session track as pg_txnid', async () => {
    const s = aamarpay();

    const payment = await s.pay
      .gateway('aamarpay')
      .charge({ amount: 1500, reference: 'ORD-1001', customer: customer(), description: 'Order #1001' });

    expect(payment.gatewayPaymentId).toBe(pgTxnId(payment.gatewayReference));
    expect(payment.checkoutUrl).toBe(
      `https://sandbox.aamarpay.com/paynow.php?track=${payment.gatewayPaymentId}`,
    );

    const sent = s.http.requests.find((r) => r.url.href === 'https://sandbox.aamarpay.com/jsonpost.php');
    expect(sent?.headers.get('content-type')).toContain('application/json');
    expect(sent?.data).toMatchObject({
      store_id: 'aamarpaytest',
      signature_key: 'dbb74894e82415a2f7ff0ec3a97e4183',
      tran_id: payment.gatewayReference,
      amount: '1500.00',
      currency: 'BDT',
      desc: 'Order #1001',
      cus_email: 'rahim@example.com',
      cus_phone: '01711000000',
      opt_a: 'ORD-1001',
      type: 'json',
    });
    expect(String(sent?.data.success_url).endsWith('/bdpaygate/aamarpay/success')).toBe(true);
    expect(String(sent?.data.fail_url).endsWith('/bdpaygate/aamarpay/fail')).toBe(true);
    expect(
      String(sent?.data.cancel_url).endsWith(
        `/bdpaygate/aamarpay/cancel?tran_id=${payment.gatewayReference}`,
      ),
    ).toBe(true);
  });

  it('searches by tran_id with the credentials in the query string', async () => {
    const s = aamarpay();
    const payment = await charge(s, 'ORD-Q', 100);

    await s.pay.sync(payment);

    const sent = s.http.requests.find((r) => r.url.pathname === '/api/v1/trxcheck/request.php');
    expect(sent?.method).toBe('GET');
    expect(sent?.url.href.startsWith('https://sandbox.aamarpay.com/api/v1/trxcheck/request.php?')).toBe(true);
    expect(sent?.data).toMatchObject({
      request_id: payment.gatewayReference,
      store_id: 'aamarpaytest',
      type: 'json',
    });
  });

  it('throws on result false with an errors list (HTTP 200)', async () => {
    const s = aamarpay({ [INIT]: () => reply({ result: false, errors: ['Invalid or missing cus_email.'] }) });

    await expect(charge(s, 'ORD-E1', 100)).rejects.toThrow('Invalid or missing cus_email.');
  });

  it('throws on result false with a message (HTTP 200)', async () => {
    const s = aamarpay({ [INIT]: () => reply({ result: false, message: 'Invalid Signature Key' }) });

    await expect(charge(s, 'ORD-E2', 100)).rejects.toThrow('Invalid Signature Key');
  });

  it('throws on a plain-text answer to init', async () => {
    const s = aamarpay({ [INIT]: () => reply('Invalid Store ID', 200, { 'content-type': 'text/html' }) });

    await expect(charge(s, 'ORD-E3', 100)).rejects.toThrow('Invalid Store ID');
  });

  it('refuses a payment_url that is not https', async () => {
    const s = aamarpay({
      [INIT]: () =>
        reply({ result: 'true', payment_url: 'http://sandbox.aamarpay.com/paynow.php?track=AAM1' }),
    });

    await expect(charge(s, 'ORD-E4', 100)).rejects.toThrow(GatewayError);
  });

  it('leaves the payment pending when search answers in plain text', async () => {
    const s = aamarpay({
      [SEARCH]: () => reply('Store_id & signature key not matched', 200, { 'content-type': 'text/html' }),
    });
    const payment = await charge(s, 'ORD-TXT', 100);
    const callback = s.successCallback(payment);

    const back = await hit(s.pay, callback);
    const ipn = await hit(s.pay, post('/bdpaygate/aamarpay/ipn', callback.data, true));

    expect(location(back)).toBe('/pending');
    expect(ipn.status).toBe(503);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it.each([
    ['initiated', '0', 'Not-Available', PaymentStatus.Pending],
    ['successful', '2', 'Successful', PaymentStatus.Completed],
    ['expired', '3', 'Expired', PaymentStatus.Failed],
    ['failed', '7', 'Failed', PaymentStatus.Failed],
    ['undocumented', '5', 'Something', PaymentStatus.Pending],
  ] as const)('maps status_code 0, 2, 3 and 7 (%s)', async (_label, code, payStatus, expected) => {
    const s = new AamarPayScenario();
    aamarpay(
      {
        [SEARCH]: (r) =>
          searched(s, r, {
            status_code: code,
            pay_status: payStatus,
            status_title: `${payStatus} Transaction`,
          }),
      },
      s,
    );
    const payment = await charge(s, `ORD-${code}`);

    await s.pay.sync(payment);

    const after = await fresh(s, payment);
    expect(after.status).toBe(expected);

    if (expected === PaymentStatus.Failed) {
      expect(after.failureReason).toBe(`${payStatus} Transaction`);
    }
  });

  it('stores bank_trxid as the transaction id', async () => {
    const s = aamarpay();
    const payment = await charge(s, 'ORD-BK');

    await s.pay.sync(payment);

    const after = await fresh(s, payment);
    expect(after.gatewayTransactionId).toBe(`BK${payment.gatewayReference.slice(2, 10)}`);
    expect(after.requiresReview).toBe(false);
  });

  it('treats Not-Available as empty', async () => {
    const s = new AamarPayScenario();
    aamarpay({ [SEARCH]: (r) => searched(s, r, { bank_trxid: 'Not-Available' }) }, s);
    const payment = await charge(s, 'ORD-NA');

    await s.pay.sync(payment);

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.gatewayTransactionId).toBeNull();
  });

  it('does not complete when status_code and pay_status disagree', async () => {
    const s = new AamarPayScenario();
    aamarpay({ [SEARCH]: (r) => searched(s, r, { pay_status: 'Failed' }) }, s);
    const payment = await charge(s, 'ORD-DIS');

    expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Pending);
  });

  it('rejects a callback whose pg_txnid belongs to another session, without searching', async () => {
    const s = aamarpay();
    let completed = 0;
    s.pay.on('payment.completed', () => {
      completed++;
    });
    const payment = await charge(s, 'ORD-PG');

    const spec = s.successCallback(payment);
    const response = await hit(s.pay, { ...spec, data: { ...spec.data, pg_txnid: 'AAM0000000000000' } });

    expect(location(response)).toBe('/failed');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
    expect(searches(s)).toBe(0);
    expect(completed).toBe(0);
  });

  it('does not complete when search reports a newer session for the same tran_id', async () => {
    const s = new AamarPayScenario();
    aamarpay({ [SEARCH]: (r) => searched(s, r, { pg_txnid: 'AAM9999999999999' }) }, s);
    let completed = 0;
    s.pay.on('payment.completed', () => {
      completed++;
    });
    const payment = await charge(s, 'ORD-NEW');

    const response = await hit(s.pay, s.successCallback(payment));

    expect(location(response)).toBe('/failed');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
    expect(completed).toBe(0);
  });

  it('does not complete when search is about a different mer_txnid', async () => {
    const s = new AamarPayScenario();
    aamarpay({ [SEARCH]: (r) => searched(s, r, { mer_txnid: 'BPOTHER' }) }, s);
    const payment = await charge(s, 'ORD-MER');

    const sync = s.pay.sync(payment);

    await expect(sync).rejects.toThrow(GatewayError);
    await expect(sync).rejects.toThrow('different mer_txnid');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it('keeps an unknown tran_id (Invalid-Data) pending', async () => {
    const s = aamarpay({
      [SEARCH]: (r) =>
        reply({ request_id: r.data.request_id, store_id: 'aamarpaytest', status: 'Invalid-Data' }),
    });
    const payment = await charge(s, 'ORD-INV');

    expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Pending);
    expect(gatewayResponse(await fresh(s, payment), 'sync')?.status).toBe('Invalid-Data');
  });

  it('accepts the cross-site success POST and redirects with a GET', async () => {
    const s = aamarpay();
    const payment = await charge(s, 'ORD-CSRF');

    const response = await hit(s.pay, s.successCallback(payment));

    expect(response.status).toBe(303);
    expect(location(response)).toBe(`/paid?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('settles a JSON IPN', async () => {
    const s = aamarpay();
    const payment = await charge(s, 'ORD-IPN');

    const response = await hit(s.pay, post('/bdpaygate/aamarpay/ipn', s.searched(payment), true));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'completed' });
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('identifies the cancel return by the tran_id it was given, and confirms it', async () => {
    const s = aamarpay();
    const payment = await charge(s, 'ORD-CAN');

    s.state = 'unpaid';
    const pending = await hit(
      s.pay,
      get('/bdpaygate/aamarpay/cancel', { tran_id: payment.gatewayReference }),
    );
    expect(location(pending)).toBe(`/pending?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);

    s.state = 'failed';
    const failed = await hit(s.pay, get('/bdpaygate/aamarpay/cancel', { tran_id: payment.gatewayReference }));
    expect(location(failed)).toBe(`/failed?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Failed);
  });

  it('checks amount_currency and currency_merchant for USD payments', async () => {
    const s = new AamarPayScenario();
    aamarpay(
      {
        [SEARCH]: (r) =>
          searched(s, r, {
            amount: '4382.80',
            currency: 'BDT',
            currency_merchant: 'USD',
            amount_currency: '40.00',
          }),
      },
      s,
      'USD',
    );
    const payment = await charge(s, 'ORD-USD', 40);

    expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Completed);
  });

  it('has no refund API', async () => {
    const s = aamarpay();
    const payment = await charge(s, 'ORD-REF', 100);

    const refund = s.pay.refund(payment);

    await expect(refund).rejects.toThrow(UnsupportedOperationError);
    await expect(refund).rejects.toThrow('Refund from the merchant panel');
  });
});
