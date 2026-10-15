/*
 * EPS specifics. The shared behaviour (verification, races, retries, sync) is
 * covered by tests/conformance.test.ts via tests/conformance/eps.scenario.ts.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EpsGateway } from '../../src/drivers/eps.js';
import {
  createBdPayGate,
  GatewayError,
  type JsonObject,
  type Payment,
  PaymentStatus,
} from '../../src/index.js';
import EpsScenario, { EPS_INIT, EPS_STATUS } from '../conformance/eps.scenario.js';
import { type Handler, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer, hit, post } from '../support/scenario.js';

const epsHash = (value: string): string =>
  createHmac('sha512', 'eps-hash-key').update(value).digest('base64');

/** Boot EPS with the scenario's token and init routes, plus a custom status route. */
function epsWithStatus(status: Handler): EpsScenario {
  const s = new EpsScenario();
  const routes = s.routes.bind(s);
  s.routes = () => ({ ...routes(), [EPS_STATUS]: status });

  return s.boot();
}

function eps(s: EpsScenario): EpsGateway {
  const gateway = s.pay.gateway('eps');

  if (!(gateway instanceof EpsGateway)) {
    throw new Error('Not the EPS driver');
  }

  return gateway;
}

function charge(s: EpsScenario, reference: string, description?: string): Promise<Payment> {
  return s.pay.gateway('eps').charge({ amount: 150, reference, customer: customer(), description });
}

/** The first EPS payment in the store. */
function firstPayment(s: EpsScenario): Payment {
  const payment = [...s.store.payments.values()].find((p) => p.gateway === 'eps');

  if (!payment) {
    throw new Error('No EPS payment');
  }

  return payment;
}

async function fresh(s: EpsScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

function epsPaid(payment: Payment, overrides: JsonObject = {}): JsonObject {
  return {
    MerchantTransactionId: payment.gatewayReference,
    EpsTransactionId: 'C2549190401',
    Status: 'Success',
    TotalAmount: payment.amount,
    StoreAmount: '146.95',
    FinancialEntity: 'BKash',
    PaymentReferance: null,
    ErrorCode: null,
    ErrorMessage: null,
    ...overrides,
  };
}

/** A raw request to a callback URL, exactly as written (no re-encoding). */
function visit(s: EpsScenario, pathAndQuery: string): Promise<Response> {
  return s.pay.fetch(new Request(`${BASE_URL}${pathAndQuery}`));
}

const count = (s: EpsScenario, part: string): number =>
  s.http.requests.filter((r) => r.url.href.includes(part)).length;

afterEach(() => {
  vi.useRealTimers();
});

describe('EPS', () => {
  it('signs every call with x-hash over the documented value', async () => {
    const s = new EpsScenario().boot();

    const payment = await charge(s, 'ORD-EPS-1', 'Order #1');
    await s.pay.sync(payment);

    expect(
      s.http.requests.some(
        (r) =>
          r.url.pathname.endsWith('/v1/Auth/GetToken') &&
          r.headers.get('x-hash') === epsHash('eps-user') &&
          r.data.userName === 'eps-user' &&
          r.data.password === 'eps-pass',
      ),
    ).toBe(true);

    expect(
      s.http.requests.some(
        (r) =>
          r.url.pathname.endsWith('/v1/EPSEngine/InitializeEPS') &&
          r.headers.get('x-hash') === epsHash(payment.gatewayReference) &&
          r.headers.get('authorization') === 'Bearer eps.jwt.token' &&
          r.data.merchantTransactionId === payment.gatewayReference &&
          r.data.merchantId === 'MID-1' &&
          r.data.storeId === 'SID-1' &&
          r.data.ValueB === 'ORD-EPS-1' &&
          String(r.data.CustomerOrderId).startsWith('ORD-EPS-1-') &&
          Number(r.data.totalAmount) === 150 &&
          String(r.data.successUrl).endsWith('/bdpaygate/eps/success') &&
          String(r.data.failUrl).endsWith('/bdpaygate/eps/fail') &&
          String(r.data.cancelUrl).endsWith('/bdpaygate/eps/cancel'),
      ),
    ).toBe(true);

    expect(
      s.http.requests.some(
        (r) =>
          r.method === 'GET' &&
          r.url.href.includes(
            `CheckMerchantTransactionStatus?merchantTransactionId=${payment.gatewayReference}`,
          ) &&
          r.headers.get('x-hash') === epsHash(payment.gatewayReference),
      ),
    ).toBe(true);

    expect(payment.gatewayPaymentId).toBe(`EPS${payment.gatewayReference}`);
    expect(payment.gatewayReference).toMatch(/^\d{20}$/);
  });

  it('computes x-hash as base64 HMAC-SHA512 of the value', async () => {
    const s = new EpsScenario().boot();
    const hash = await eps(s).hash('20240117001');

    expect(hash).toBe(createHmac('sha512', 'eps-hash-key').update('20240117001').digest('base64'));
    expect(hash).toHaveLength(88);
  });

  it('caches the token across calls', async () => {
    const s = new EpsScenario().boot();

    await charge(s, 'ORD-EPS-2');
    await charge(s, 'ORD-EPS-3');

    expect(s.http.requests).toHaveLength(3);
    expect(count(s, 'GetToken')).toBe(1);
  });

  it('fetches a new token once when EPS answers 401', async () => {
    const s = new EpsScenario();
    const routes = s.routes.bind(s);
    let calls = 0;
    s.routes = () => ({
      ...routes(),
      [EPS_INIT]: () =>
        ++calls === 1
          ? reply({ message: 'Unauthorized' }, 401)
          : reply({
              TransactionId: 'T1',
              RedirectURL: 'https://sandboxpg.eps.com.bd/x',
              ErrorCode: null,
              ErrorMessage: null,
            }),
    });
    s.boot();

    const payment = await charge(s, 'ORD-EPS-401');

    expect(payment.checkoutUrl).toBe('https://sandboxpg.eps.com.bd/x');
    expect(count(s, 'GetToken')).toBe(2);
  });

  it('throws on a token error that comes back with HTTP 200', async () => {
    const s = new EpsScenario();
    s.routes = () => ({
      'sandboxpgapi.eps.com.bd/*': () =>
        reply({ token: null, expireDate: null, errorMessage: 'Invalid user', errorCode: '401' }),
    });
    s.boot();

    const attempt = charge(s, 'ORD-EPS-4');

    await expect(attempt).rejects.toThrow(GatewayError);
    await expect(attempt).rejects.toThrow('Invalid user');
  });

  it('throws when InitializeEPS refuses, with the error in a 200 body', async () => {
    const s = new EpsScenario();
    const routes = s.routes.bind(s);
    s.routes = () => ({
      ...routes(),
      [EPS_INIT]: () =>
        reply({ TransactionId: null, RedirectURL: null, ErrorMessage: 'Invalid store', ErrorCode: '1001' }),
    });
    s.boot();

    const attempt = charge(s, 'ORD-EPS-5');

    await expect(attempt).rejects.toThrow(GatewayError);
    await expect(attempt).rejects.toThrow('Invalid store');
  });

  it('retries the transient 404 right after payment, then completes', async () => {
    let calls = 0;
    const s = epsWithStatus(() =>
      ++calls < 3 ? reply({ title: 'Not Found' }, 404) : reply(epsPaid(firstPayment(s))),
    );
    const completed: string[] = [];
    s.pay.on('payment.completed', ({ payment }) => {
      completed.push(payment.id);
    });

    const payment = await charge(s, 'ORD-EPS-6');
    const response = await visit(
      s,
      `/bdpaygate/eps/success?Status=Success&MerchantTransactionId=${payment.gatewayReference}`,
    );

    expect(response.status).toBe(303);

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.gatewayTransactionId).toBe('C2549190401');
    expect(completed).toEqual([payment.id]);
  });

  it.each(['success', 'fail', 'cancel'])(
    'leaves the payment pending, not failed, when the status API keeps answering 404 (%s)',
    async (outcome) => {
      const s = epsWithStatus(() => reply({ title: 'Not Found' }, 404));

      const payment = await charge(s, 'ORD-EPS-7');
      const response = await visit(
        s,
        `/bdpaygate/eps/${outcome}?Status=Failed&MerchantTransactionId=${payment.gatewayReference}`,
      );

      expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
      expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
      expect(s.http.requests).toHaveLength(5); // token, init, 3 status attempts
    },
  );

  it('never trusts Status=Success in the return URL', async () => {
    const s = epsWithStatus(() => reply(epsPaid(firstPayment(s), { Status: 'Pending' })));
    let events = 0;
    s.pay.on('payment.completed', () => {
      events++;
    });

    const payment = await charge(s, 'ORD-EPS-8');
    const response = await visit(
      s,
      `/bdpaygate/eps/success?Status=Success&amount=150&MerchantTransactionId=${payment.gatewayReference}`,
    );

    expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
    expect(events).toBe(0);
  });

  it.each([
    ['Success', PaymentStatus.Completed],
    ['SUCCESSFUL', PaymentStatus.Completed],
    ['completed', PaymentStatus.Completed],
    ['Failed', PaymentStatus.Failed],
    ['FAILURE', PaymentStatus.Failed],
    ['Cancelled', PaymentStatus.Cancelled],
    ['Aborted', PaymentStatus.Cancelled],
    ['Pending', PaymentStatus.Pending],
    ['Initiated', PaymentStatus.Pending],
    ['', PaymentStatus.Pending],
  ])('maps EPS status word "%s" case-insensitively', async (word, expected) => {
    const s = epsWithStatus(() => reply(epsPaid(firstPayment(s), { Status: word })));

    const payment = await charge(s, 'ORD-EPS-9');

    expect((await s.pay.sync(payment)).status).toBe(expected);
  });

  it('reads camelCase or nested status responses with literal nulls', async () => {
    const s = epsWithStatus(() =>
      reply({
        data: {
          merchantTransactionId: firstPayment(s).gatewayReference,
          status: 'SUCCESS',
          totalAmount: '150.00',
          ErrorMessage: null,
        },
      }),
    );

    const payment = await charge(s, 'ORD-EPS-10');

    expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Completed);
  });

  it('reads return parameters whose separators EPS HTML-escaped', async () => {
    const s = epsWithStatus(() => reply(epsPaid(firstPayment(s))));

    const payment = await charge(s, 'ORD-EPS-11');
    const response = await visit(
      s,
      `/bdpaygate/eps/success?Status=Success&amp;MerchantTransactionId=${payment.gatewayReference}`,
    );

    expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('treats an encrypted IPN as a nudge to check recent pending payments', async () => {
    const s = epsWithStatus(async ({ url }) => {
      const payment = await s.store.findBy(
        'eps',
        'gatewayReference',
        String(url.searchParams.get('merchantTransactionId')),
      );

      if (!payment) {
        throw new Error('unknown payment');
      }

      return reply(
        epsPaid(payment, { Status: payment.reference === 'ORD-EPS-PAID' ? 'Success' : 'Pending' }),
      );
    });

    const paid = await charge(s, 'ORD-EPS-PAID');
    const open = await charge(s, 'ORD-EPS-OPEN');

    const response = await hit(
      s.pay,
      post(
        '/bdpaygate/eps/ipn',
        { Data: `${randomBytes(16).toString('base64')}:${randomBytes(64).toString('base64')}` },
        true,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'completed' });
    expect((await fresh(s, paid)).status).toBe(PaymentStatus.Completed);
    expect((await fresh(s, open)).status).toBe(PaymentStatus.Pending);
  });

  it('sweeps at most once a minute, without 404 retries, so a flood of IPNs cannot amplify', async () => {
    let calls = 0;
    const s = epsWithStatus(() => {
      calls++;

      return reply({ message: 'Not found' }, 404);
    });

    await charge(s, 'ORD-EPS-F1');
    await charge(s, 'ORD-EPS-F2');

    for (let i = 0; i < 5; i++) {
      const response = await hit(s.pay, post('/bdpaygate/eps/ipn', { Data: 'aXY=:Y2lwaGVy' }, true));
      expect(response.status).toBe(200);
    }

    expect(calls).toBe(2); // one status call per pending payment, once
  });

  it('sweeps again once the minute has passed', async () => {
    let calls = 0;
    const s = epsWithStatus(() => {
      calls++;

      return reply({ message: 'Not found' }, 404);
    });

    await charge(s, 'ORD-EPS-F3');
    vi.useFakeTimers({ toFake: ['Date'] });

    await hit(s.pay, post('/bdpaygate/eps/ipn', { Data: 'aXY=:Y2lwaGVy' }, true));
    await hit(s.pay, post('/bdpaygate/eps/ipn', { Data: 'aXY=:Y2lwaGVy' }, true));
    expect(calls).toBe(1);

    vi.setSystemTime(Date.now() + 61_000);
    await hit(s.pay, post('/bdpaygate/eps/ipn', { Data: 'aXY=:Y2lwaGVy' }, true));
    expect(calls).toBe(2);
  });

  it('rejects an IPN when there is nothing pending to confirm', async () => {
    const s = new EpsScenario().boot();

    const response = await hit(s.pay, post('/bdpaygate/eps/ipn', { Data: 'aXY=:Y2lwaGVy' }, true));

    expect(response.status).toBe(400);
  });

  it('refuses a status answer about a different transaction', async () => {
    const s = epsWithStatus(() =>
      reply(epsPaid(firstPayment(s), { MerchantTransactionId: '99999999999999999999' })),
    );

    const payment = await charge(s, 'ORD-EPS-12');
    const response = await visit(
      s,
      `/bdpaygate/eps/success?MerchantTransactionId=${payment.gatewayReference}`,
    );

    expect(response.headers.get('location')).toBe('/failed');
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it('only accepts BDT', async () => {
    const s = new EpsScenario().boot();
    const pay = createBdPayGate({
      baseUrl: BASE_URL,
      gateways: { eps: s.config() },
      currency: 'USD',
      store: s.store,
      cache: s.cache,
      fetch: s.http.fetch,
    });

    await expect(
      pay.gateway('eps').charge({ amount: 150, reference: 'ORD-EPS-13', customer: customer() }),
    ).rejects.toThrow('only accepts BDT');
  });

  it('stores the 20-digit merchant transaction id from the first insert', async () => {
    const s = new EpsScenario().boot();
    const inserted: string[] = [];
    const insert = s.store.insert.bind(s.store);
    s.store.insert = async (payment) => {
      inserted.push(payment.gatewayReference);
      await insert(payment);
    };

    await charge(s, 'ORD-EPS-14');

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatch(/^\d{20}$/);
  });

  it('uses the live host when sandbox is off', () => {
    const s = new EpsScenario();
    const pay = createBdPayGate({ baseUrl: BASE_URL, gateways: { eps: { ...s.config(), sandbox: false } } });
    const gateway = pay.gateway('eps');

    expect(gateway instanceof EpsGateway && gateway.baseUrl).toBe('https://pgapi.eps.com.bd');
  });
});
