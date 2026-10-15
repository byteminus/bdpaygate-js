import { describe, expect, it } from 'vitest';
import {
  AbstractGateway,
  type CallbackResult,
  type ChargeOptions,
  ConfigurationError,
  createBdPayGate,
  GatewayError,
  gatewaysFromEnv,
  matchPath,
  type Payment,
  parseBody,
  parseParams,
  UnsupportedOperationError,
} from '../src/index.js';
import { customer, hit } from './support/scenario.js';

function setup(extra: Parameters<typeof createBdPayGate>[0]['gateways'] = {}, production = false) {
  const pay = createBdPayGate({
    baseUrl: 'https://shop.test/',
    gateways: { fake: {}, ...extra },
    redirects: { success: '/paid', failed: '/failed', cancelled: '/cancelled', pending: '/pending' },
    logger: { warn() {} },
    production,
  });
  const fake = pay.fake();
  const events: string[] = [];
  pay.on('payment.completed', ({ payment }) => {
    events.push(`completed:${payment.id}`);
  });
  pay.on('payment.duplicated', ({ payment }) => {
    events.push(`duplicated:${payment.id}`);
  });
  pay.on('payment.failed', ({ payment }) => {
    events.push(`failed:${payment.id}`);
  });

  return { pay, fake, events };
}

const charge = (
  pay: ReturnType<typeof setup>['pay'],
  reference: string,
  amount: number | string = 100,
  gateway?: string,
) => pay.charge({ gateway, amount, reference, customer: customer() });

describe('payment lifecycle', () => {
  it('fires payment.completed once when two requests race to complete the same payment', async () => {
    const { pay, fake, events } = setup();
    const payment = await charge(pay, 'RACE-1');

    // Two requests loaded the payment before either saved.
    const a = (await pay.find(payment.id)) as Payment;
    const b = (await pay.find(payment.id)) as Payment;

    const [first, second] = await Promise.all([fake.complete(a), fake.complete(b)]);

    expect([first.changed, second.changed].sort()).toEqual([false, true]);
    expect(second.status).toBe('completed');
    expect(events).toEqual([`completed:${payment.id}`]);
  });

  it('lets a confirmed payment override an earlier failure, but never the reverse', async () => {
    const { pay, fake } = setup();
    const payment = await charge(pay, 'LATE-1');

    await fake.fail(payment);
    expect((await pay.find(payment.id))?.status).toBe('failed');

    await fake.complete(payment);
    expect((await pay.find(payment.id))?.status).toBe('completed');

    const result = await fake.fail(payment);
    expect(result.changed).toBe(false);
    expect((await pay.find(payment.id))?.status).toBe('completed');
  });

  it('keeps earlier attempts and reports a second paid attempt as a duplicate', async () => {
    const { pay, fake, events } = setup();
    const old = await charge(pay, 'DUP-1');
    const fresh = await charge(pay, 'DUP-1');

    expect(old.gatewayReference).not.toBe(fresh.gatewayReference);
    expect(await pay.attempts('DUP-1')).toHaveLength(2);

    await fake.complete(fresh);
    await fake.complete(old); // the customer also paid the old checkout page

    expect(events).toEqual([`completed:${fresh.id}`, `duplicated:${old.id}`]);
  });

  it('refuses to charge a reference that is already paid', async () => {
    const { pay, fake } = setup();
    await fake.complete(await charge(pay, 'PAID-1'));

    await expect(charge(pay, 'PAID-1')).rejects.toThrow(/already been paid/);
  });

  it('validates the reference and the amount', async () => {
    const { pay } = setup();

    await expect(charge(pay, '')).rejects.toBeInstanceOf(GatewayError);
    await expect(charge(pay, 'x'.repeat(65))).rejects.toThrow(/1 to 64/);
    await expect(charge(pay, 'A-1', 0)).rejects.toThrow(/greater than zero/);
    await expect(charge(pay, 'A-1', 'abc')).rejects.toThrow(/greater than zero/);
    await expect(charge(pay, 'A-1', Number.NaN)).rejects.toThrow(/greater than zero/);
    expect((await charge(pay, 'A-2', '1234.5')).amount).toBe('1234.50');
    expect((await charge(pay, 'A-3', 10.005)).amount).toBe('10.01');
    expect((await charge(pay, 'A-4', 0.1 + 0.2)).amount).toBe('0.30');
  });
});

describe('refunds', () => {
  it('refuses refunds above what is left', async () => {
    const { pay, fake } = setup();
    const payment = await charge(pay, 'REF-1');
    await fake.complete(payment);

    await expect(pay.refund(payment, 150)).rejects.toThrow(/exceeds/);
  });

  it('refuses refunds on unpaid payments', async () => {
    const { pay } = setup();

    await expect(pay.refund(await charge(pay, 'REF-2'))).rejects.toThrow(/not paid/);
  });

  it('refunds in parts down to zero and fires refund.processed', async () => {
    const { pay, fake } = setup();
    const refunds: string[] = [];
    pay.on('refund.processed', ({ refund }) => {
      refunds.push(refund.amount);
    });
    const payment = await charge(pay, 'REF-3', 300);
    await fake.complete(payment);

    await pay.refund(payment, 100);
    expect(payment.status).toBe('partially_refunded');
    await pay.refund(payment);

    expect(payment.status).toBe('refunded');
    expect(payment.refundedAmount).toBe('300.00');
    expect(refunds).toEqual(['100.00', '200.00']);
    await expect(pay.refund(payment, 1)).rejects.toThrow(/exceeds/);
  });

  it('says clearly when a gateway has no refund API', async () => {
    class CashOnDelivery extends AbstractGateway {
      static override readonly driver = 'norefund';

      charge(options: ChargeOptions): Promise<Payment> {
        return this.createPendingPayment(options);
      }

      handleCallback(): Promise<CallbackResult> {
        throw new Error('unused');
      }
    }

    const { pay } = setup({ cod: { driver: 'norefund' } });
    pay.extend('norefund', (config, name, ctx) => new CashOnDelivery(config, name, ctx));
    const payment = await charge(pay, 'COD-1', 100, 'cod');
    await pay.store.update({ ...payment, status: 'completed' });

    await expect(pay.refund((await pay.find(payment.id)) as Payment)).rejects.toThrow(
      UnsupportedOperationError,
    );
    await expect(pay.refund((await pay.find(payment.id)) as Payment)).rejects.toThrow(/no refund API/);
    await expect(pay.sync(payment)).rejects.toThrow(/no status API/);
  });
});

describe('gateways and config', () => {
  it('uses the config key as the gateway name, so two stores of one driver stay apart', async () => {
    const { pay } = setup({ shop_a: { driver: 'fake' }, shop_b: { driver: 'fake' } });

    const a = await charge(pay, 'SAME-REF', 10, 'shop_a');
    const b = await charge(pay, 'SAME-REF', 10, 'shop_b');

    expect(a.gateway).toBe('shop_a');
    expect(b.gateway).toBe('shop_b');
    expect(a.checkoutUrl).toContain('https://shop.test/bdpaygate/shop_a/success');
    expect(pay.for(b).name).toBe('shop_b');
  });

  it('explains missing configuration', async () => {
    const pay = createBdPayGate({ gateways: { fake: {}, odd: { driver: 'nope' }, bkash: {} } });

    expect(() => pay.gateway('missing')).toThrow(ConfigurationError);
    expect(() => pay.gateway('odd')).toThrow(/not supported/);
    await expect(pay.charge({ amount: 1, reference: 'R', customer: customer() })).rejects.toThrow(/baseUrl/);
    expect(pay.store).toBeDefined();
    const withUrl = createBdPayGate({ baseUrl: 'https://shop.test', gateways: { bkash: {} } });
    await expect(withUrl.charge({ amount: 1, reference: 'R', customer: customer() })).rejects.toThrow(
      /Missing \[username\] in the \[bkash\] gateway config/,
    );
    expect(await pay.attempts('R', 'fake')).toEqual([]);
  });

  it('mounts under a custom prefix', async () => {
    const pay = createBdPayGate({
      baseUrl: 'https://shop.test',
      prefix: '/api/pay/',
      gateways: { fake: {} },
    });
    const payment = await pay.charge({ amount: 5, reference: 'P-1', customer: customer() });

    expect(pay.routePattern).toBe('/api/pay/:gateway/:outcome');
    expect(payment.checkoutUrl).toMatch(/^https:\/\/shop\.test\/api\/pay\/fake\/success\?ref=BP/);
    expect((await pay.fetch(new Request(payment.checkoutUrl as string))).status).toBe(303);
  });

  it('builds gateway configs from the same env vars as the Laravel package', () => {
    const gateways = gatewaysFromEnv({
      BKASH_APP_KEY: 'k',
      BKASH_APP_SECRET: 's',
      BKASH_SANDBOX: 'false',
      SSLCOMMERZ_STORE_ID: 'store',
      UDDOKTAPAY_API_KEY: 'u',
      NAGAD_PRIVATE_KEY: 'line1\\nline2',
      NAGAD_VERIFY_RESPONSE_SIGNATURE: 'true',
    });

    expect(gateways.bkash).toEqual({ driver: 'bkash', appKey: 'k', appSecret: 's', sandbox: false });
    expect(gateways.sslcommerz).toEqual({ driver: 'sslcommerz', storeId: 'store', sandbox: true });
    expect(gateways.uddoktapay?.sandbox).toBe(false);
    expect(gateways.nagad?.privateKey).toBe('line1\nline2');
    expect(gateways.nagad?.verifyResponseSignature).toBe(true);
    expect(gateways.upay).toBeUndefined();
  });
});

describe('callbacks', () => {
  it('refuses fake callbacks in production', async () => {
    const { pay } = setup({}, true);
    const payment = await charge(pay, 'PROD-1');

    const response = await pay.fetch(new Request(payment.checkoutUrl as string));

    expect(response.headers.get('location')).toBe('/failed');
    expect((await pay.find(payment.id))?.status).toBe('pending');
  });

  it('answers IPNs with JSON and redirects customers', async () => {
    const { pay } = setup();
    const payment = await charge(pay, 'IPN-1');

    const ipn = await hit(pay, {
      method: 'POST',
      path: '/bdpaygate/fake/ipn',
      data: { ref: payment.gatewayReference },
    });
    const bad = await hit(pay, { method: 'POST', path: '/bdpaygate/fake/ipn', data: { ref: 'nope' } });
    const redirect = await hit(pay, {
      method: 'GET',
      path: '/bdpaygate/fake/success',
      data: { ref: payment.gatewayReference },
    });

    expect(ipn.status).toBe(200);
    expect(await ipn.json()).toEqual({ ok: true, status: 'completed' });
    expect(bad.status).toBe(400);
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('location')).toBe(`/paid?payment=${payment.id}`);
  });

  it('accepts redirect functions', async () => {
    const pay = createBdPayGate({
      baseUrl: 'https://shop.test',
      gateways: { fake: {} },
      redirects: { success: (payment) => `/orders/${String(payment?.meta?.orderId)}/thanks` },
    });
    const payment = await pay.charge({
      amount: 5,
      reference: 'F-1',
      customer: customer(),
      meta: { orderId: 42 },
    });

    const response = await pay.fetch(new Request(payment.checkoutUrl as string));

    expect(response.headers.get('location')).toBe('/orders/42/thanks');
  });

  it('rethrows unexpected errors (a failing listener) so the gateway retries, after saving state', async () => {
    const { pay } = setup();
    pay.on('payment.completed', () => {
      throw new Error('mail server down');
    });
    const payment = await charge(pay, 'L-1');

    await expect(pay.fetch(new Request(payment.checkoutUrl as string))).rejects.toThrow('mail server down');
    expect((await pay.find(payment.id))?.status).toBe('completed');
  });

  it('parses params and bodies like PHP does', () => {
    expect(parseParams(new URLSearchParams('a=1&b[]=2&b[]=3&c=4&c=5'))).toEqual({
      a: '1',
      b: ['2', '3'],
      c: ['4', '5'],
    });
    expect(parseBody('application/json', '{"x":1}')).toEqual({ x: 1 });
    expect(parseBody('application/json', '[1]')).toEqual({});
    expect(parseBody('application/json', '{oops')).toEqual({});
    expect(parseBody('application/x-www-form-urlencoded; charset=UTF-8', 'x=%E0%A7%B3')).toEqual({ x: '৳' });
    expect(parseBody('text/xml', '<x/>')).toEqual({});
    expect(matchPath('/bdpaygate', '/bdpaygate/bkash/callback')).toEqual({
      gateway: 'bkash',
      outcome: 'callback',
    });
    expect(matchPath('/bdpaygate', '/app/bdpaygate/bkash/ipn/')).toEqual({
      gateway: 'bkash',
      outcome: 'ipn',
    });
    expect(matchPath('/bdpaygate', '/bdpaygate/bkash')).toBeNull();
    expect(matchPath('/bdpaygate', '/bdpaygate/bkash/ipn/extra')).toBeNull();
  });
});

describe('syncPending', () => {
  it('settles stale pending payments and skips fresh ones', async () => {
    const { pay } = setup();
    const stale = await charge(pay, 'SYNC-1');
    const fresh = await charge(pay, 'SYNC-2');
    await pay.store.update({ ...stale, createdAt: new Date(Date.now() - 3600_000) });

    const result = await pay.syncPending();

    expect(result.checked).toBe(1);
    expect(result.errors).toEqual([]);
    expect(fresh.status).toBe('pending');
  });
});
