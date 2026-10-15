/*
 * DGePay specifics. The shared behaviour (verification, races, retries, sync)
 * is covered by tests/conformance.test.ts via tests/conformance/dgepay.scenario.ts.
 */
import { createDecipheriv, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DgePayGateway } from '../../src/drivers/dgepay.js';
import { DgePayCrypto } from '../../src/drivers/dgepay-crypto.js';
import {
  createBdPayGate,
  type GatewayConfig,
  GatewayError,
  type JsonObject,
  type Payment,
  PaymentStatus,
} from '../../src/index.js';
import DgePayScenario, {
  DGEPAY_API_KEY,
  DGEPAY_AUTH,
  DGEPAY_INITIATE,
  DGEPAY_SECRET,
  DGEPAY_STATUS,
  dgepayCrypto,
} from '../conformance/dgepay.scenario.js';
import { type Handler, reply } from '../support/mock-fetch.js';
import { BASE_URL, customer } from '../support/scenario.js';

/** Boot DGePay with the scenario's auth and initiate routes, plus a custom status route. */
function dgepayWithStatus(status: Handler, config: GatewayConfig = {}): DgePayScenario {
  const s = new DgePayScenario();
  const routes = s.routes.bind(s);
  const base = s.config.bind(s);
  s.routes = () => ({ ...routes(), [DGEPAY_STATUS]: status });
  s.config = () => ({ ...base(), ...config });

  return s.boot();
}

/** The first DGePay payment in the store. */
function firstPayment(s: DgePayScenario): Payment {
  const payment = [...s.store.payments.values()].find((p) => p.gateway === 'dgepay');

  if (!payment) {
    throw new Error('No DGePay payment');
  }

  return payment;
}

function dgepayStatus(s: () => DgePayScenario, code: string, amount: number | null = null): Handler {
  return () => {
    const payment = firstPayment(s());

    return reply({
      status_code: 200,
      data: {
        message: `STATUS ${code}`,
        txn_id: 'edfba864bd7e402ebc5ca7fc3230246b',
        status_code: code,
        amount: amount ?? Number(payment.amount),
        txn_number: '50534914',
        payment_method: 'bKash',
        unique_txn_id: payment.gatewayReference,
      },
    });
  };
}

function charge(s: DgePayScenario, reference: string, description?: string): Promise<Payment> {
  return s.pay.gateway('dgepay').charge({ amount: 150, reference, customer: customer(), description });
}

async function fresh(s: DgePayScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

/** A raw request to a callback URL, exactly as written (no re-encoding). */
function visit(s: DgePayScenario, pathAndQuery: string): Promise<Response> {
  return s.pay.fetch(new Request(`${BASE_URL}${pathAndQuery}`));
}

function aesDecrypt(cipher: string, key: string): string {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key), null);

  return decipher.update(cipher, 'base64', 'utf8') + decipher.final('utf8');
}

const count = (s: DgePayScenario, part: string): number =>
  s.http.requests.filter((r) => r.url.href.includes(part)).length;

afterEach(() => {
  vi.useRealTimers();
});

describe('DGePay', () => {
  it('builds the canonical signature string the way the SDK does', async () => {
    const payload: JsonObject = {
      unique_txn_id: 'BPX1',
      redirect_url: 'https://shop.test/bdpaygate/dgepay/callback',
      note: 'Order #1, blue',
      amount: 150.0,
      customer_token: null,
      payee_information: { phone_number: '01711000000', dial_code: '+88' },
    };

    expect(dgepayCrypto().canonical(payload)).toBe(
      'amount150.0customer_tokennullnoteOrder#1bluepayee_informationdial_code+88phone_number01711000000' +
        'redirect_urlhttps//shop.test/bdpaygate/dgepay/callbackunique_txn_idBPX1',
    );

    expect(dgepayCrypto().canonical({ amount: 150.5 })).toBe('amount150.5');
    expect(await dgepayCrypto().sign({ unique_txn_id: 'BPX1' })).toBe(
      createHmac('sha256', DGEPAY_API_KEY).update('unique_txn_idBPX1').digest('base64'),
    );
  });

  it('encrypts with AES-128-ECB under the 16-byte client secret, and decrypts back', async () => {
    const payload = { unique_txn_id: 'BPX1', amount: 150.0 };
    const cipher = await dgepayCrypto().encrypt(payload);

    expect(aesDecrypt(cipher, DGEPAY_SECRET)).toBe('{"amount":150.0,"unique_txn_id":"BPX1"}');
    expect(await dgepayCrypto().decrypt(cipher)).toEqual({ amount: 150.0, unique_txn_id: 'BPX1' });
  });

  it('pads a short client secret with "0" to 16 bytes, as the SDK does', async () => {
    const cipher = await new DgePayCrypto('short', 'k').encrypt({ a: 'b' });

    expect(aesDecrypt(cipher, 'short00000000000')).toBe('{"a":"b"}');
  });

  it('sends an encrypted, signed body with the bearer token', async () => {
    const s = new DgePayScenario().boot();

    const payment = await charge(s, 'ORD-DG-1', 'Order #1');

    expect(
      s.http.requests.some(
        (r) =>
          r.url.pathname.endsWith('/payment_gateway/authenticate') &&
          r.headers.get('authorization') ===
            `Basic ${Buffer.from(`dgepay-client:${DGEPAY_SECRET}`).toString('base64')}` &&
          r.data.client_id === 'dgepay-client',
      ),
    ).toBe(true);

    const initiate = s.http.requests.find((r) =>
      r.url.pathname.endsWith('/payment_gateway/initiate_payment'),
    );
    const body = initiate ? await dgepayCrypto().decrypt(initiate.text) : null;

    expect(body).toEqual({
      amount: 150.0,
      customer_token: null,
      note: 'Order #1',
      payee_information: { dial_code: '+88', phone_number: '01711000000' },
      payment_method: null,
      redirect_url: `${BASE_URL}/bdpaygate/dgepay/callback`,
      unique_txn_id: payment.gatewayReference,
    });
    expect(initiate?.headers.get('signature')).toBe(await dgepayCrypto().sign(body ?? {}));
    expect(initiate?.headers.get('authorization')).toBe('Bearer dgepay.jwt.token');
    expect(initiate?.headers.get('content-type')).toBe('application/json');

    expect(payment.checkoutUrl).toBe(`https://pay-uat.dgepay.net/checkout/${payment.gatewayReference}`);
  });

  it('caches the token across calls', async () => {
    const s = new DgePayScenario().boot();

    await charge(s, 'ORD-DG-2');
    await charge(s, 'ORD-DG-3');

    expect(count(s, 'authenticate')).toBe(1);
  });

  it('caches the token until its JWT expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    const s = new DgePayScenario();
    const routes = s.routes.bind(s);
    const claims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 120 })).toString(
      'base64url',
    );
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${claims}.sig`;
    s.routes = () => ({
      ...routes(),
      [DGEPAY_AUTH]: () => reply({ status_code: 200, success: 1, data: { access_token: jwt } }),
    });
    s.boot();

    await charge(s, 'ORD-DG-4');
    vi.setSystemTime(Date.now() + 70_000);
    await charge(s, 'ORD-DG-5');

    expect(count(s, 'authenticate')).toBe(2);
  });

  it('throws when authentication is refused with HTTP 200', async () => {
    const s = new DgePayScenario();
    s.routes = () => ({
      'api-uat.dgepay.net/*': () =>
        reply({ status_code: 401, success: 0, data: null, error: ['Credentials are not valid'] }),
    });
    s.boot();

    const attempt = charge(s, 'ORD-DG-6');

    await expect(attempt).rejects.toThrow(GatewayError);
    await expect(attempt).rejects.toThrow('Credentials are not valid');
  });

  it('throws when initiate_payment answers success 0', async () => {
    const s = new DgePayScenario();
    const routes = s.routes.bind(s);
    s.routes = () => ({
      ...routes(),
      [DGEPAY_INITIATE]: () =>
        reply({ status_code: 200, success: 0, data: null, error: ['REQUESTED_PARAMETERS_ARE_MISMATCHED'] }),
    });
    s.boot();

    const attempt = charge(s, 'ORD-DG-7');

    await expect(attempt).rejects.toThrow(GatewayError);
    await expect(attempt).rejects.toThrow('REQUESTED_PARAMETERS_ARE_MISMATCHED');
  });

  it('restores "+" that query parsing turned into spaces before decrypting', async () => {
    const s = dgepayWithStatus(dgepayStatus(() => s, '3'));
    const completed: string[] = [];
    s.pay.on('payment.completed', ({ payment }) => {
      completed.push(payment.id);
    });
    const payment = await charge(s, 'ORD-DG-8');

    // Find a payload whose ciphertext contains "+", then send it unencoded, as DGePay does.
    let cipher = '';

    for (let i = 0; !cipher.includes('+'); i++) {
      cipher = await dgepayCrypto().encrypt({
        status_code: '3',
        unique_txn_id: payment.gatewayReference,
        n: i,
      });
    }

    const response = await visit(s, `/bdpaygate/dgepay/callback?data=${cipher}`);

    expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.gatewayPaymentId).toBe('edfba864bd7e402ebc5ca7fc3230246b');
    expect(after.gatewayTransactionId).toBe('50534914');
    expect(completed).toEqual([payment.id]);
  });

  it.each([
    ['3', PaymentStatus.Completed],
    ['8', PaymentStatus.Cancelled],
    ['4', PaymentStatus.Failed],
    ['1', PaymentStatus.Pending],
    ['2', PaymentStatus.Pending],
    ['', PaymentStatus.Pending],
  ])(
    'maps status code "%s" (3 paid, 8 cancelled, 4 failed, anything else pending)',
    async (code, expected) => {
      const s = dgepayWithStatus(dgepayStatus(() => s, code));
      const payment = await charge(s, 'ORD-DG-9');

      expect((await s.pay.sync(payment)).status).toBe(expected);
    },
  );

  it('lets the failure codes be configured', async () => {
    const s = dgepayWithStatus(
      dgepayStatus(() => s, '4'),
      { failedStatusCodes: ['5'] },
    );
    const payment = await charge(s, 'ORD-DG-10');

    expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Pending);
  });

  it('never trusts the status_code inside the redirect payload', async () => {
    const s = dgepayWithStatus(dgepayStatus(() => s, '1'));
    let events = 0;
    s.pay.on('payment.completed', () => {
      events++;
    });
    const payment = await charge(s, 'ORD-DG-11');

    const data = await dgepayCrypto().encrypt({
      status_code: '3',
      unique_txn_id: payment.gatewayReference,
      amount: 150.0,
    });
    const response = await visit(s, `/bdpaygate/dgepay/callback?${new URLSearchParams({ data })}`);

    expect(response.headers.get('location')).toBe(`/pending?payment=${payment.id}`);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
    expect(events).toBe(0);
  });

  it('stays pending when the status API has no data for the transaction', async () => {
    const s = dgepayWithStatus(() =>
      reply({ status_code: 200, success: 0, data: null, error: ['Transaction not found'] }),
    );
    const payment = await charge(s, 'ORD-DG-12');

    expect((await s.pay.sync(payment)).status).toBe(PaymentStatus.Pending);
  });

  it('rejects a redirect whose data does not decrypt', async () => {
    const s = new DgePayScenario().boot();
    await charge(s, 'ORD-DG-13');

    const response = await visit(
      s,
      `/bdpaygate/dgepay/callback?data=${Buffer.from('not a ciphertext').toString('base64')}`,
    );

    expect(response.headers.get('location')).toBe('/failed');
    expect(count(s, 'check_transaction_status')).toBe(0);
  });

  it('only accepts BDT', async () => {
    const s = new DgePayScenario().boot();
    const pay = createBdPayGate({
      baseUrl: BASE_URL,
      gateways: { dgepay: s.config() },
      currency: 'USD',
      store: s.store,
      cache: s.cache,
      fetch: s.http.fetch,
    });

    await expect(
      pay.gateway('dgepay').charge({ amount: 150, reference: 'ORD-DG-14', customer: customer() }),
    ).rejects.toThrow('only accepts BDT');
  });

  it('uses the live host when sandbox is off, and baseUrl for DEV', () => {
    const config = new DgePayScenario().config();
    const pay = createBdPayGate({
      baseUrl: BASE_URL,
      gateways: {
        dgepay: { ...config, sandbox: false },
        'dgepay-dev': { ...config, baseUrl: DgePayGateway.DEV_URL },
      },
    });
    const live = pay.gateway('dgepay');
    const dev = pay.gateway('dgepay-dev');

    expect(live instanceof DgePayGateway && live.baseUrl).toBe('https://apiv2.dgepay.net/dipon/v3');
    expect(dev instanceof DgePayGateway && dev.baseUrl).toBe('https://api-dev.dgepay.net/dipon/v3');
  });
});
