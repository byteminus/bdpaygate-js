/*
 * SSLCommerz specifics. The shared behaviour (verification, races, retries,
 * refunds, sync) is covered by tests/conformance.test.ts via tests/conformance/sslcommerz.scenario.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  createBdPayGate,
  GatewayError,
  gatewayResponse,
  type Payment,
  PaymentStatus,
} from '../../src/index.js';
import SslCommerzScenario, { sslcommerzSigned } from '../conformance/sslcommerz.scenario.js';
import { mockFetch, type Routes, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer, hit, post } from '../support/scenario.js';

const CREATE = 'sandbox.sslcommerz.com/gwprocess/v4/api.php';
const VALIDATE = 'sandbox.sslcommerz.com/validator/api/validationserverAPI.php';
const QUERY = 'sandbox.sslcommerz.com/validator/api/merchantTransIDvalidationAPI.php';

/** Boot the scenario, with stubs replacing the scenario's for the same URL. */
function sslcommerz(
  overrides: Routes = {},
  currency = 'BDT',
  s = new SslCommerzScenario(),
): SslCommerzScenario {
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

async function fresh(s: SslCommerzScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

/** The one payment in the store, for stubs that answer about it. */
function only(s: SslCommerzScenario): Payment {
  const [payment] = [...s.store.payments.values()];

  if (!payment) {
    throw new Error('no payment yet');
  }

  return payment;
}

describe('sslcommerz', () => {
  it('sends the attempt id as tran_id and the merchant reference alongside', async () => {
    const s = sslcommerz();

    const payment = await s.pay.gateway('sslcommerz').charge({
      amount: 1500,
      reference: 'ORD-1001',
      customer: customer(),
      description: 'Order #1001',
      meta: { order_id: 1001 },
    });

    expect(payment.gatewayPaymentId).toBe(`SESS${payment.gatewayReference}`);
    expect(payment.meta).toEqual({ order_id: 1001 });

    const sent = s.http.requests.find((r) => r.url.pathname === '/gwprocess/v4/api.php');
    expect(sent?.method).toBe('POST');
    expect(sent?.data).toMatchObject({
      tran_id: payment.gatewayReference,
      value_b: 'ORD-1001',
      total_amount: '1500.00',
      store_id: 'teststore',
    });
    expect(String(sent?.data.success_url)).toContain('/bdpaygate/sslcommerz/success');
    expect(String(sent?.data.ipn_url)).toContain('/bdpaygate/sslcommerz/ipn');
  });

  it('throws when sslcommerz refuses the session', async () => {
    const s = sslcommerz({
      [CREATE]: () =>
        reply({ status: 'FAILED', failedreason: 'Store Credential Error Or Store is De-active' }),
    });

    await expect(
      s.pay.gateway('sslcommerz').charge({ amount: 100, reference: 'ORD-1002', customer: customer() }),
    ).rejects.toThrow(/Store Credential Error/);
  });

  it('refuses amounts outside 10 to 500000 BDT before calling the gateway', async () => {
    const s = sslcommerz();

    const charge = s.pay
      .gateway('sslcommerz')
      .charge({ amount: 5, reference: 'ORD-1003', customer: customer() });

    await expect(charge).rejects.toThrow(GatewayError);
    await expect(charge).rejects.toThrow('10.00 to 500000.00');
    expect(s.http.requests).toHaveLength(0);
  });

  it('rejects a success callback with a tampered signature without asking the API', async () => {
    const s = sslcommerz();
    let completed = 0;
    s.pay.on('payment.completed', () => {
      completed++;
    });
    const payment = await s.pay
      .gateway('sslcommerz')
      .charge({ amount: 250, reference: 'ORD-2002', customer: customer() });

    const spec = s.successCallback(payment);
    const response = await hit(s.pay, { ...spec, data: { ...spec.data, amount: '1.00' } }); // edited after signing

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/failed');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
    expect(s.http.requests.some((r) => r.url.pathname.includes('validationserverAPI'))).toBe(false);
    expect(completed).toBe(0);
  });

  it('checks currency_type and currency_amount for foreign currency payments', async () => {
    const s = sslcommerz(
      {
        [CREATE]: () => reply({ status: 'SUCCESS', sessionkey: 'S', GatewayPageURL: 'https://x' }),
        [VALIDATE]: () =>
          reply({
            status: 'VALID',
            tran_id: only(s).gatewayReference,
            amount: '12000.00',
            currency_type: 'USD',
            currency_amount: '100.00',
            bank_tran_id: 'B1',
          }),
      },
      'USD',
    );

    const payment = await s.pay
      .gateway('sslcommerz')
      .charge({ amount: 100, reference: 'ORD-USD', customer: customer() });

    const response = await hit(
      s.pay,
      post(
        '/bdpaygate/sslcommerz/ipn',
        sslcommerzSigned({
          tran_id: payment.gatewayReference,
          val_id: 'V1',
          amount: '12000.00',
          status: 'VALID',
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('flags risky payments for review', async () => {
    const s = sslcommerz({
      [CREATE]: () => reply({ status: 'SUCCESS', sessionkey: 'S', GatewayPageURL: 'https://x' }),
      [VALIDATE]: () =>
        reply({
          status: 'VALID',
          tran_id: only(s).gatewayReference,
          amount: '100.00',
          bank_tran_id: 'B1',
          risk_level: '1',
          risk_title: 'Unusual card',
        }),
    });

    const payment = await s.pay
      .gateway('sslcommerz')
      .charge({ amount: 100, reference: 'ORD-RISK', customer: customer() });
    await hit(
      s.pay,
      post(
        '/bdpaygate/sslcommerz/ipn',
        sslcommerzSigned({
          tran_id: payment.gatewayReference,
          val_id: 'V1',
          amount: '100.00',
          status: 'VALID',
        }),
      ),
    );

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.requiresReview).toBe(true);
  });

  it('sends refund_trans_id and does not count a "processing" duplicate as a refund', async () => {
    const answers = [
      { APIConnect: 'DONE', status: 'success', refund_ref_id: 'REF1' },
      { APIConnect: 'DONE', status: 'processing' },
    ];
    let call = 0;
    const s = sslcommerz({ [QUERY]: () => reply(answers[Math.min(call++, answers.length - 1)]) });

    const now = new Date();
    const payment: Payment = {
      id: '01JREFUND5001',
      gateway: 'sslcommerz',
      reference: 'ORD-5001',
      gatewayReference: 'BPREF5001',
      gatewayPaymentId: null,
      gatewayTransactionId: 'B5',
      amount: '500.00',
      refundedAmount: '0.00',
      currency: 'BDT',
      status: PaymentStatus.Completed,
      requiresReview: false,
      failureReason: null,
      description: null,
      checkoutUrl: null,
      customer: null,
      meta: null,
      gatewayResponse: [],
      paidAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await s.store.insert(payment);

    const first = await s.pay.refund(payment, 200, 'Damaged item');
    const second = await s.pay.refund(payment, 200, 'Damaged item');

    expect(first.accepted).toBe(true);
    expect(first.pending).toBe(true);
    expect(first.refundId).toBe('REF1');
    expect(second.accepted).toBe(false);
    expect(second.message).toBe('Refund already initiated');
    expect((await fresh(s, payment)).refundedAmount).toBe('200.00');
    expect(
      s.http.requests.some(
        (r) => r.url.search.includes('refund_trans_id=RF') && r.url.search.includes('bank_tran_id=B5'),
      ),
    ).toBe(true);
    expect(gatewayResponse(await fresh(s, payment), 'refund_rejected')?.status).toBe('processing');
  });
});
