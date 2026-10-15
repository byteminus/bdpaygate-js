import { createHash } from 'node:crypto';
import type { GatewayConfig, JsonObject, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

const HOST = 'sandbox.shurjopayment.com';

export const spOrderId = (orderId: string): string =>
  `sp${createHash('md5').update(orderId).digest('hex').slice(0, 13)}`;

export const tokenResponse = () => ({
  token: 'sandbox-token',
  store_id: 1,
  execute_url: 'https://sandbox.shurjopayment.com/api/secret-pay',
  token_type: 'Bearer',
  sp_code: '200',
  message: 'Ok',
  token_create_time: '2026-10-15 11:29:54am',
  expires_in: 900,
});

/**
 * Response shapes follow the ShurjoPay sandbox (token, secret-pay, verification).
 */
export default class ShurjoPayScenario extends GatewayScenario {
  readonly gateway = 'shurjopay';

  config(): GatewayConfig {
    return {
      driver: 'shurjopay',
      username: 'sp_sandbox',
      password: 'pyyk97hu&6u6',
      prefix: 'sp',
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      [`${HOST}/api/get_token`]: () => reply(tokenResponse()),

      [`${HOST}/api/secret-pay`]: ({ data }) =>
        reply({
          checkout_url: `https://sandbox.securepay.shurjopayment.com/spaycheckout/?token=t&order_id=${spOrderId(String(data.order_id))}`,
          amount: data.amount,
          currency: data.currency,
          sp_order_id: spOrderId(String(data.order_id)),
          customer_order_id: data.order_id,
          customer_name: data.customer_name,
          intent: 'sale',
          transactionStatus: 'Initiated',
        }),

      [`${HOST}/api/verification`]: this.verification(async ({ data }) => {
        const payment = await this.payment('gatewayPaymentId', data.order_id);

        return reply([this.verified(payment)]);
      }),
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/shurjopay/success', { order_id: payment.gatewayPaymentId });
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/shurjopay/cancel', { order_id: payment.gatewayPaymentId });
  }

  verified(payment: Payment): JsonObject {
    const [code, message] =
      this.state === 'paid'
        ? ['1000', 'Success']
        : this.state === 'failed'
          ? ['1002', 'Cancel']
          : ['1068', 'initiated'];
    const reported = Number(this.reported(payment)).toFixed(4);

    return {
      id: 142332,
      order_id: payment.gatewayPaymentId,
      currency: 'BDT',
      amount: reported,
      payable_amount: reported,
      recived_amount: this.state === 'paid' ? this.reported(payment) : null,
      bank_trx_id: this.state === 'paid' ? `BTX${payment.gatewayReference.slice(2, 10)}` : null,
      customer_order_id: payment.gatewayReference,
      sp_code: code,
      sp_massage: message,
      sp_message: message,
      method: this.state === 'paid' ? 'bKash' : null,
      value1: payment.reference,
      value4: '2627-8588620331',
    };
  }
}
