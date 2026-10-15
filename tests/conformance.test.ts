/*
 * Every gateway must pass these. A gateway is "supported" when it does.
 * Scenarios live in tests/conformance; see tests/support/scenario.ts.
 *
 * CONFORMANCE=bkash,nagad npx vitest run tests/conformance.test.ts runs only those.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type Payment, PaymentStatus, refundableAmount } from '../src/index.js';
import { customer, type GatewayScenario, hit, mangle } from './support/scenario.js';

type ScenarioClass = new () => GatewayScenario;

const modules = import.meta.glob<{ default: ScenarioClass }>('./conformance/*.scenario.ts', { eager: true });
const only = (process.env.CONFORMANCE ?? '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const scenarios = Object.entries(modules)
  .map(([file, mod]) => [file.replace(/^.*\/(.+)\.scenario\.ts$/, '$1'), mod.default] as const)
  .filter(([name]) => only.length === 0 || only.includes(name));

function chargeWith(s: GatewayScenario, reference = 'ORD-CONF-1'): Promise<Payment> {
  return s.pay.gateway(s.gateway).charge({
    amount: s.chargeAmount,
    reference,
    customer: customer(),
    description: 'Conformance order',
  });
}

async function fresh(s: GatewayScenario, payment: Payment): Promise<Payment> {
  const found = await s.store.find(payment.id);

  if (!found) {
    throw new Error('payment vanished');
  }

  return found;
}

describe.each(scenarios)('%s conformance', (_name, Scenario) => {
  let current: GatewayScenario | undefined;

  const boot = (): GatewayScenario => {
    const scenario = new Scenario().boot();
    current = scenario;

    return scenario;
  };

  afterEach(() => {
    // Every outbound call must hit a stub: an unmatched one hides a wrong URL.
    expect(current?.http.unmatched ?? []).toEqual([]);
  });

  it('charges: returns a pending attempt with a checkout url', async () => {
    const s = boot();
    const payment = await chargeWith(s);

    expect(payment.status).toBe(PaymentStatus.Pending);
    expect(payment.checkoutUrl).toBeTypeOf('string');
    expect(payment.checkoutUrl).not.toBe('');
    expect(payment.gateway).toBe(s.gateway);
    expect(payment.amount).toBe(s.chargeAmount);
  });

  it('retries a reference as a new attempt with a fresh gateway reference', async () => {
    const s = boot();
    const first = await chargeWith(s);
    const second = await chargeWith(s);

    expect(second.gatewayReference).not.toBe(first.gatewayReference);
    expect(second.reference).toBe(first.reference);
    expect(await s.store.find(first.id)).not.toBeNull();
  });

  it('completes exactly once on a verified success callback, even when replayed', async () => {
    const s = boot();
    const completed: string[] = [];
    s.pay.on('payment.completed', ({ payment }) => {
      completed.push(payment.id);
    });
    s.pay.on('payment.duplicated', ({ payment }) => {
      completed.push(payment.id);
    });
    const payment = await chargeWith(s);

    await hit(s.pay, s.successCallback(await fresh(s, payment)));
    await hit(s.pay, s.successCallback(await fresh(s, payment)));

    const after = await fresh(s, payment);
    expect(after.status).toBe(PaymentStatus.Completed);
    expect(after.paidAt).not.toBeNull();
    expect(completed).toEqual([payment.id]);
  });

  it('does not complete when the gateway says the payment is not paid', async () => {
    const s = boot();
    let events = 0;
    s.pay.on('payment.completed', () => {
      events++;
    });
    const payment = await chargeWith(s);
    s.state = 'unpaid';

    const response = await hit(s.pay, s.successCallback(await fresh(s, payment)));

    expect(response.status).toBeLessThan(500);
    expect((await fresh(s, payment)).status).not.toBe(PaymentStatus.Completed);
    expect(events).toBe(0);
  });

  it('does not complete when the gateway reports a different amount', async () => {
    const s = boot();
    let events = 0;
    s.pay.on('payment.completed', () => {
      events++;
    });
    const payment = await chargeWith(s);
    s.reportedAmount = '1.00';

    await hit(s.pay, s.successCallback(await fresh(s, payment)));

    expect((await fresh(s, payment)).status).not.toBe(PaymentStatus.Completed);
    expect(events).toBe(0);
  });

  it('stays pending, without an error page, when the gateway cannot be reached', async () => {
    const s = boot();
    const payment = await chargeWith(s);
    s.state = 'down';

    const response = await hit(s.pay, s.successCallback(await fresh(s, payment)));

    expect(response.status).toBeLessThan(500);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });

  it('ignores a failure callback for a payment the gateway says is paid', async (context) => {
    const s = boot();
    const payment = await chargeWith(s);
    const failure = s.failureCallback(await fresh(s, payment));

    if (!failure) {
      context.skip('No distinct failure callback.');

      return;
    }

    await hit(s.pay, failure);

    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('marks a confirmed failure, and still completes on a later confirmed success', async (context) => {
    const s = boot();
    const payment = await chargeWith(s);
    const failure = s.failureCallback(await fresh(s, payment));

    if (!failure) {
      context.skip('No distinct failure callback.');

      return;
    }

    s.state = 'failed';
    await hit(s.pay, failure);
    expect([PaymentStatus.Failed, PaymentStatus.Cancelled]).toContain((await fresh(s, payment)).status);

    s.state = 'paid';
    await hit(s.pay, s.successCallback(await fresh(s, payment)));
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);
  });

  it('rejects a callback for a payment it does not know', async () => {
    const s = boot();
    const payment = await chargeWith(s);
    const request = s.successCallback(await fresh(s, payment));
    s.store.payments.delete(payment.id);

    const response = await hit(s.pay, request);

    expect(response.status).toBeLessThan(500);
    expect(s.store.payments.size).toBe(0);
  });

  it('syncs a pending payment from the status API', async (context) => {
    const s = boot();

    if (!s.pay.gateway(s.gateway).capabilities.sync) {
      context.skip('No status API.');

      return;
    }

    const payment = await chargeWith(s);
    s.state = 'unpaid';
    const before = s.beforeSync(await fresh(s, payment));

    if (before) {
      await hit(s.pay, before);
    }

    expect((await s.pay.sync(await fresh(s, payment))).status).toBe(PaymentStatus.Pending);

    s.state = 'paid';
    expect((await s.pay.sync(await fresh(s, payment))).status).toBe(PaymentStatus.Completed);
  });

  it('refunds a completed payment', async (context) => {
    const s = boot();
    const gateway = s.pay.gateway(s.gateway);

    if (!gateway.capabilities.refunds) {
      context.skip('No refund API.');

      return;
    }

    const payment = await chargeWith(s);
    await hit(s.pay, s.successCallback(await fresh(s, payment)));
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Completed);

    if (gateway.capabilities.refunds === 'partial') {
      const part = await s.pay.refund(await fresh(s, payment), '50.00', 'Partial');
      expect(part.accepted).toBe(true);
      expect((await fresh(s, payment)).status).toBe(PaymentStatus.PartiallyRefunded);
    }

    const rest = await s.pay.refund(await fresh(s, payment), null, 'Rest');
    const after = await fresh(s, payment);

    expect(rest.accepted).toBe(true);
    expect(after.status).toBe(PaymentStatus.Refunded);
    expect(refundableAmount(after)).toBe('0.00');
  });

  it('rejects malformed callbacks without an error page or a state change', async () => {
    const s = boot();
    const payment = await chargeWith(s);

    const response = await hit(s.pay, mangle(s.successCallback(await fresh(s, payment))));

    expect(response.status).toBeLessThan(500);
    expect((await fresh(s, payment)).status).toBe(PaymentStatus.Pending);
  });
});
