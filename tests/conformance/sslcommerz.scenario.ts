import { createHash } from 'node:crypto';
import type { GatewayConfig, JsonObject, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, post } from '../support/scenario.js';

const HOST = 'sandbox.sslcommerz.com';

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

/** Build a callback payload signed the way SSLCommerz signs it. */
export function sslcommerzSigned(
  fields: Record<string, string>,
  storePassword = 'teststore@ssl',
): Record<string, string> {
  const hash: Record<string, string> = { ...fields, store_passwd: md5(storePassword) };
  const pairs = Object.keys(hash)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}=${hash[key]}`);

  return {
    ...fields,
    verify_key: Object.keys(fields).join(','),
    verify_sign: md5(pairs.join('&')),
  };
}

export default class SslCommerzScenario extends GatewayScenario {
  readonly gateway = 'sslcommerz';

  config(): GatewayConfig {
    return {
      driver: 'sslcommerz',
      storeId: 'teststore',
      storePassword: 'teststore@ssl',
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      [`${HOST}/gwprocess/v4/api.php`]: ({ data }) =>
        reply({
          status: 'SUCCESS',
          sessionkey: `SESS${String(data.tran_id)}`,
          GatewayPageURL: `https://sandbox.sslcommerz.com/EasyCheckOut/testcde${String(data.tran_id)}`,
        }),

      [`${HOST}/validator/api/validationserverAPI.php`]: this.verification(async ({ data }) => {
        const payment = await this.payment('gatewayReference', String(data.val_id).slice(4));

        return reply(this.state === 'paid' ? this.paidElement(payment) : { status: 'INVALID_TRANSACTION' });
      }),

      [`${HOST}/validator/api/merchantTransIDvalidationAPI.php`]: this.verification(async ({ data }) => {
        if (data.refund_trans_id !== undefined) {
          return reply({
            APIConnect: 'DONE',
            status: 'success',
            refund_ref_id: `REF${String(data.refund_trans_id)}`,
            bank_tran_id: data.bank_tran_id,
          });
        }

        const payment = await this.payment('gatewayReference', data.tran_id);

        switch (this.state) {
          case 'paid':
            return reply({ APIConnect: 'DONE', no_of_trans_found: 1, element: [this.paidElement(payment)] });
          case 'failed':
            return reply({
              APIConnect: 'DONE',
              no_of_trans_found: 1,
              element: [{ status: 'FAILED', tran_id: payment.gatewayReference, amount: payment.amount }],
            });
          default:
            return reply({ APIConnect: 'DONE', no_of_trans_found: 0, element: [] });
        }
      }),
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return post(
      '/bdpaygate/sslcommerz/success',
      sslcommerzSigned({
        tran_id: payment.gatewayReference,
        val_id: `VAL-${payment.gatewayReference}`,
        amount: payment.amount,
        currency: 'BDT',
        status: 'VALID',
      }),
    );
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return post('/bdpaygate/sslcommerz/fail', {
      tran_id: payment.gatewayReference,
      status: 'FAILED',
      error: 'Declined by bank',
    });
  }

  paidElement(payment: Payment): JsonObject {
    return {
      status: 'VALID',
      tran_id: payment.gatewayReference,
      val_id: `VAL-${payment.gatewayReference}`,
      amount: this.reported(payment),
      currency: 'BDT',
      bank_tran_id: `BANK${payment.gatewayReference.slice(2, 10)}`,
      risk_level: '0',
    };
  }
}
