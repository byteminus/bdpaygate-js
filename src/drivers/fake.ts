import { InvalidCallbackError } from '../core/errors.js';
import { AbstractGateway } from '../core/gateway.js';
import type { CallbackRequest } from '../core/request.js';
import {
  type CallbackResult,
  type Capabilities,
  type ChargeOptions,
  type Outcome,
  type Payment,
  PaymentStatus,
  type RefundResult,
} from '../core/types.js';

/**
 * No network. For local development and your app's tests: the checkout URL
 * points straight back at the success callback, and you can complete, fail
 * or cancel a payment from code.
 *
 * Its callbacks trust the URL, so they refuse to run in production unless
 * `allowInProduction` is set.
 */
export class FakeGateway extends AbstractGateway {
  static override readonly driver = 'fake';

  override readonly capabilities: Capabilities = { sync: true, refunds: 'partial' };

  async charge(options: ChargeOptions): Promise<Payment> {
    const payment = await this.createPendingPayment(options);
    payment.gatewayPaymentId = `FAKE-${payment.gatewayReference}`;
    payment.checkoutUrl = this.callbackUrl('success', { ref: payment.gatewayReference });

    return this.save(payment);
  }

  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    if (this.ctx.production && this.config.allowInProduction !== true) {
      throw new InvalidCallbackError('The fake gateway is disabled in production.', this.name);
    }

    const payment = await this.findByGatewayReference(request.string('ref'));

    switch (outcome) {
      case 'success':
      case 'ipn':
        return this.complete(payment);
      case 'cancel':
        return this.cancel(payment);
      default:
        return this.fail(payment);
    }
  }

  complete(payment: Payment): Promise<CallbackResult> {
    return this.transition(
      payment,
      PaymentStatus.Completed,
      { gatewayTransactionId: `FAKETRX${payment.gatewayReference.slice(2, 10)}` },
      'fake',
      { outcome: 'success' },
    );
  }

  fail(payment: Payment): Promise<CallbackResult> {
    return this.transition(payment, PaymentStatus.Failed, {}, 'fake', { outcome: 'fail' });
  }

  cancel(payment: Payment): Promise<CallbackResult> {
    return this.transition(payment, PaymentStatus.Cancelled, {}, 'fake', { outcome: 'cancel' });
  }

  override async sync(payment: Payment): Promise<Payment> {
    return this.reload(payment);
  }

  protected override async requestRefund(
    payment: Payment,
    amount: string,
    reason: string | null,
  ): Promise<RefundResult> {
    return this.refundResult(payment, {
      accepted: true,
      amount,
      refundId: `FAKEREF${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      message: reason,
      raw: { outcome: 'refunded', amount },
    });
  }
}
