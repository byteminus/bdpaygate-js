import { createHash } from 'node:crypto';
import type { GatewayConfig, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

export const CHECKOUT = 'pay.merchant.test/api/checkout-v2';
export const VERIFY = 'pay.merchant.test/api/verify-payment';

export const invoiceId = (payment: Payment): string => `INV-${payment.gatewayReference}`;

/**
 * A self-hosted UddoktaPay install at pay.merchant.test. Response shapes
 * follow uddoktapay.readme.io (Create Charge, Verify Payment) and what the
 * public sandbox returned on 2026-10-15 ("No Data Found" as status ERROR).
 *
 * UddoktaPay only reports COMPLETED, PENDING or ERROR, so there is no
 * verifiable failure callback: failureCallback() stays null.
 */
export default class UddoktaPayScenario extends GatewayScenario {
  readonly gateway = 'uddoktapay';

  config(): GatewayConfig {
    return {
      driver: 'uddoktapay',
      apiKey: 'test-uddoktapay-key',
      baseUrl: 'https://pay.merchant.test',
      sandbox: false,
    };
  }

  routes(): Routes {
    return {
      [CHECKOUT]: ({ data }) => {
        const metadata = data.metadata as { gateway_reference?: unknown } | undefined;

        return reply({
          status: true,
          message: 'Payment Url',
          payment_url: `https://pay.merchant.test/payment/${createHash('sha1')
            .update(String(metadata?.gateway_reference))
            .digest('hex')}`,
        });
      },

      [VERIFY]: this.verification(async ({ data }) => {
        const payment = await this.store.findBy(
          this.gateway,
          'gatewayReference',
          String(data.invoice_id).slice(4),
        );

        if (!payment || this.state === 'failed') {
          return reply({ status: 'ERROR', message: 'No Data Found' });
        }

        return reply(this.invoice(payment, this.state === 'paid' ? 'COMPLETED' : 'PENDING'));
      }),
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/uddoktapay/success', { invoice_id: invoiceId(payment) });
  }

  /**
   * UddoktaPay only creates the invoice_id when the customer submits a
   * payment, so charge() alone gives sync nothing to look up: the return
   * (with state "unpaid") registers the invoice first.
   */
  override beforeSync(payment: Payment): CallbackSpec {
    return this.successCallback(payment);
  }

  invoice(payment: Payment, status: string) {
    return {
      full_name: 'Rahim Uddin',
      email: 'rahim@example.com',
      amount: this.reported(payment),
      fee: '0.00',
      charged_amount: this.reported(payment),
      invoice_id: invoiceId(payment),
      metadata: {
        gateway_reference: payment.gatewayReference,
        reference: payment.reference,
        payment_id: payment.id,
      },
      payment_method: 'bkash',
      sender_number: '01311111111',
      transaction_id: `TESTTRANS${payment.gatewayReference.slice(2, 8)}`,
      date: '2026-10-15 14:00:50',
      status,
    };
  }
}
