import type { GatewayConfig, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

export const INITIATE = 'sandbox.paystation.com.bd/initiate-payment';
export const STATUS = 'sandbox.paystation.com.bd/transaction-status';

/**
 * Response shapes follow PayStation's documentation and what its sandbox
 * returned on 2026-10-15 (string status_code, HTTP 200 for business errors,
 * "Success"/"Failed" capitalised in trx_status).
 */
export default class PayStationScenario extends GatewayScenario {
  readonly gateway = 'paystation';

  config(): GatewayConfig {
    return {
      driver: 'paystation',
      merchantId: '104-0000000000',
      password: 'test-store-pass',
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      [INITIATE]: ({ data }) =>
        reply({
          status_code: '200',
          status: 'success',
          message: 'Payment Link Created Successfully.',
          payment_amount: data.payment_amount,
          invoice_number: data.invoice_number,
          payment_url: `https://sandbox.paystation.com.bd/checkout/12117920422621191/${String(data.invoice_number)}`,
        }),

      [STATUS]: this.verification(async ({ data }) => {
        const payment = await this.store.findBy(
          this.gateway,
          'gatewayReference',
          String(data.invoice_number),
        );

        if (!payment) {
          return reply({ status_code: '2001', status: 'failed', message: 'Transaction not found in system' });
        }

        return reply({
          status_code: '200',
          status: 'success',
          message: 'Transaction found',
          data: this.transaction(payment),
        });
      }),
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/paystation/callback', {
      status: 'Successful',
      invoice_number: payment.gatewayReference,
      trx_id: `TRX${payment.gatewayReference.slice(2, 10)}`,
    });
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/paystation/callback', {
      status: 'Failed',
      invoice_number: payment.gatewayReference,
    });
  }

  transaction(payment: Payment, trxStatus: string | null = null) {
    const paid = this.state === 'paid';

    return {
      invoice_number: payment.gatewayReference,
      trx_status:
        trxStatus ?? (this.state === 'paid' ? 'Success' : this.state === 'failed' ? 'Failed' : 'processing'),
      trx_id: paid ? `TRX${payment.gatewayReference.slice(2, 10)}` : '',
      request_amount: this.reported(payment),
      payment_amount: this.reported(payment),
      order_date_time: '2026-10-15 11:31:02',
      payer_mobile_no: paid ? '01700000001' : '',
      payment_method: paid ? 'bKash' : '',
      reference: payment.reference,
      checkout_items: null,
      opt_a: payment.id,
      opt_b: null,
      opt_c: null,
    };
  }
}
