import type { GatewayConfig, JsonObject, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, post } from '../support/scenario.js';

const HOST = 'sandbox.aamarpay.com';

/** CRC-32 (IEEE), unsigned, as PHP's sprintf('%u', crc32()). */
function crc32(value: string): number {
  let crc = 0xffffffff;

  for (const byte of new TextEncoder().encode(value)) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export const pgTxnId = (tranId: string): string => `AAM${crc32(tranId)}`;

/**
 * Response shapes follow the aamarPay sandbox (jsonpost.php and Search Transaction).
 */
export default class AamarPayScenario extends GatewayScenario {
  readonly gateway = 'aamarpay';

  config(): GatewayConfig {
    return {
      driver: 'aamarpay',
      storeId: 'aamarpaytest',
      signatureKey: 'dbb74894e82415a2f7ff0ec3a97e4183',
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      [`${HOST}/jsonpost.php`]: ({ data }) =>
        reply({
          result: 'true',
          payment_url: `https://sandbox.aamarpay.com/paynow.php?track=${pgTxnId(String(data.tran_id))}`,
        }),

      [`${HOST}/api/v1/trxcheck/request.php`]: this.verification(async ({ data }) => {
        const payment = await this.payment('gatewayReference', data.request_id);

        return reply(this.searched(payment));
      }),
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return post('/bdpaygate/aamarpay/success', {
      pay_status: 'Successful',
      status_code: '2',
      mer_txnid: payment.gatewayReference,
      pg_txnid: pgTxnId(payment.gatewayReference),
      epw_txnid: pgTxnId(payment.gatewayReference),
      amount: payment.amount,
      currency: 'BDT',
      currency_merchant: 'BDT',
      card_type: 'bKash-bKash',
    });
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return post('/bdpaygate/aamarpay/fail', {
      pay_status: 'Failed',
      status_code: '7',
      mer_txnid: payment.gatewayReference,
      pg_txnid: pgTxnId(payment.gatewayReference),
      amount: payment.amount,
      currency: 'BDT',
      reason: 'Declined',
    });
  }

  searched(payment: Payment): JsonObject {
    const [code, payStatus, title] =
      this.state === 'paid'
        ? ['2', 'Successful', 'Successful Transaction']
        : this.state === 'failed'
          ? ['7', 'Failed', 'Failed Transaction']
          : ['0', 'Not-Available', 'Payment Not Yet Received'];
    const paid = this.state === 'paid';

    return {
      pg_txnid: pgTxnId(payment.gatewayReference),
      mer_txnid: payment.gatewayReference,
      risk_title: 'Safe',
      risk_level: '0',
      store_id: 'aamarpaytest',
      amount: this.reported(payment),
      amount_bdt: this.reported(payment),
      amount_original: this.reported(payment),
      amount_currency: this.reported(payment),
      pay_status: payStatus,
      status_code: code,
      status_title: title,
      bank_trxid: paid ? `BK${payment.gatewayReference.slice(2, 10)}` : 'Not-Available',
      payment_type: paid ? 'bKash' : 'Not-Available',
      error_code: paid ? '0000' : 'Not-Available',
      currency: 'BDT',
      currency_merchant: 'BDT',
      opt_a: payment.reference,
      checkout_status: paid ? 'Paid' : 'Not-Paid-Yet',
    };
  }
}
