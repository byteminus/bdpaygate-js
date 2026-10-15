import { createHash } from 'node:crypto';
import type { GatewayConfig, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

const HOST = 'tokenized.sandbox.bka.sh/v2/tokenized-checkout';

export const signature = (paymentId: string): string =>
  `SIG${createHash('md5').update(paymentId).digest('hex').slice(0, 8)}`;

export const tokenResponse = (idToken: string, refreshToken: string, expiresIn = 3600) => ({
  statusCode: '0000',
  statusMessage: 'Successful',
  token_type: 'Bearer',
  id_token: idToken,
  refresh_token: refreshToken,
  expires_in: expiresIn,
});

/** A V2 Create Payment response, with callback URLs carrying the signature. */
export function created(
  invoice: string,
  amount: string,
  callbackUrl = 'https://shop.test/bdpaygate/bkash/callback',
) {
  const paymentId = `TR0011${invoice}`;
  const query = (status: string) =>
    `${callbackUrl}?paymentID=${paymentId}&status=${status}&signature=${signature(paymentId)}`;

  return {
    paymentId,
    paymentCreateTime: '2026-09-20T12:31:28:970 GMT+0600',
    transactionStatus: 'Initiated',
    amount,
    currency: 'BDT',
    intent: 'sale',
    merchantInvoiceNumber: invoice,
    bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${paymentId}&hash=abc&mode=0011&apiVersion=v2`,
    callbackURL: callbackUrl,
    successCallbackURL: query('success'),
    failureCallbackURL: query('failure'),
    cancelledCallbackURL: query('cancel'),
    signature: signature(paymentId),
  };
}

export const error = (code: string, message: string, internal = 'error') => ({
  internalCode: internal,
  externalCode: code,
  errorMessageEn: message,
  errorMessageBn: null,
});

/**
 * bKash Tokenized Checkout V2. Shapes follow the samples on developer.bka.sh:
 * no statusCode on success, paymentId/trxId casing, externalCode/errorMessageEn errors.
 */
export default class BkashScenario extends GatewayScenario {
  readonly gateway = 'bkash';

  config(): GatewayConfig {
    return {
      driver: 'bkash',
      appKey: 'app-key',
      appSecret: 'app-secret',
      username: 'sandboxuser',
      password: 'sandboxpass',
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      [`${HOST}/auth/grant-token`]: () => reply(tokenResponse('ID-TOKEN', 'REFRESH-1')),
      [`${HOST}/auth/refresh-token`]: () => reply(tokenResponse('ID-TOKEN-2', 'REFRESH-2')),

      [`${HOST}/payment/create`]: ({ data }) =>
        reply(created(String(data.merchantInvoiceNumber), String(data.amount), String(data.callbackURL))),

      [`${HOST}/payment/execute`]: this.verification(async ({ data }) => {
        const payment = await this.payment('gatewayPaymentId', data.paymentId);

        return reply(
          this.state === 'paid'
            ? this.completed(payment)
            : error('2056', 'Invalid Payment State', 'invalid_payment_state'),
        );
      }),

      [`${HOST}/query/payment`]: this.verification(async ({ data }) => {
        const payment = await this.payment('gatewayPaymentId', data.paymentId);

        return reply(
          this.state === 'paid'
            ? { ...this.completed(payment), verificationStatus: 'Complete' }
            : {
                paymentId: payment.gatewayPaymentId,
                transactionStatus: this.state === 'failed' ? 'Cancelled' : 'Initiated',
                verificationStatus: 'Incomplete',
                amount: payment.amount,
                currency: 'BDT',
                intent: 'sale',
                merchantInvoice: payment.gatewayReference,
              },
        );
      }),

      [`${HOST}/refund/payment/transaction`]: ({ data }) =>
        reply({
          originalTrxId: data.trxId,
          refundTrxId: `RF${crypto.randomUUID().slice(0, 8)}`,
          refundTransactionStatus: 'Completed',
          originalTrxAmount: '150.00',
          refundAmount: data.refundAmount,
          currency: 'BDT',
          completedTime: '2026-09-20T14:47:03:555 GMT+0600',
          sku: data.sku,
          reason: data.reason,
        }),
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/bkash/callback', {
      paymentID: payment.gatewayPaymentId,
      status: 'success',
      signature: signature(String(payment.gatewayPaymentId)),
    });
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/bkash/callback', {
      paymentID: payment.gatewayPaymentId,
      status: 'cancel',
      signature: signature(String(payment.gatewayPaymentId)),
    });
  }

  private completed(payment: Payment) {
    return {
      paymentId: payment.gatewayPaymentId,
      trxId: `TRX${payment.gatewayReference.slice(2, 9)}`,
      transactionStatus: 'Completed',
      amount: this.reported(payment),
      currency: 'BDT',
      intent: 'sale',
      paymentExecuteTime: '2026-09-20T12:34:11:929 GMT+0600',
      merchantInvoiceNumber: payment.gatewayReference,
      payerReference: '01711000000',
      payerAccount: '01711000000',
      maxRefundableAmount: this.reported(payment),
    };
  }
}
