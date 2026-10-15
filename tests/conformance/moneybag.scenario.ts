import type { GatewayConfig, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

export const CHECKOUT = 'sandbox.api.moneybag.com.bd/api/v2/payments/checkout';
export const VERIFY = 'sandbox.api.moneybag.com.bd/api/v2/payments/verify/*';

export default class MoneybagScenario extends GatewayScenario {
  readonly gateway = 'moneybag';

  config(): GatewayConfig {
    return {
      driver: 'moneybag',
      apiKey: 'mb-merchant-key',
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      [CHECKOUT]: ({ data }) =>
        reply({
          success: true,
          data: {
            checkout_url: `https://sandbox.payment.moneybag.com.bd/moneybag-landing?sessionId=ps${String(data.order_id)}`,
            session_id: `ps${String(data.order_id)}`,
            expires_at: '2026-10-15T15:00:00Z',
          },
          message: 'Checkout session created',
        }),

      [VERIFY]: this.verification(async ({ url }) => {
        const transactionId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        const payment = await this.payment('gatewayReference', transactionId.slice(3));

        return reply(
          this.verified(
            payment,
            this.state === 'paid' ? 'SUCCESS' : this.state === 'failed' ? 'FAILED' : 'PENDING',
          ),
        );
      }),
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/moneybag/success', {
      ref: payment.gatewayReference,
      transaction_id: `txn${payment.gatewayReference}`,
      status: 'SUCCESS',
    });
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/moneybag/fail', {
      ref: payment.gatewayReference,
      transaction_id: `txn${payment.gatewayReference}`,
      status: 'FAILED',
    });
  }

  verified(payment: Payment, status: string) {
    return {
      success: true,
      data: {
        transaction_id: `txn${payment.gatewayReference}`,
        order_id: payment.gatewayReference,
        verified: status === 'SUCCESS',
        status,
        amount: this.reported(payment),
        charge_amount: '0.00',
        currency: 'BDT',
        payment_method: 'card',
        payment_reference_id: `REF${payment.gatewayReference.slice(2, 10)}`,
        customer: { name: 'Rahim Uddin', email: 'rahim@example.com', phone: '01711000000' },
      },
      message: 'Payment verification details retrieved',
    };
  }
}
