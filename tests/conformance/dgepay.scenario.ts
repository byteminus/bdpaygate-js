import { createCipheriv } from 'node:crypto';
import { DgePayCrypto } from '../../src/drivers/dgepay-crypto.js';
import type { GatewayConfig, JsonObject, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

export const DGEPAY_SECRET = 'dgepay-secret-16';
export const DGEPAY_API_KEY = 'dgepay-api-key';

export const DGEPAY_HOST = 'api-uat.dgepay.net/dipon/v3/payment_gateway';
export const DGEPAY_AUTH = `${DGEPAY_HOST}/authenticate`;
export const DGEPAY_INITIATE = `${DGEPAY_HOST}/initiate_payment`;
export const DGEPAY_STATUS = `${DGEPAY_HOST}/check_transaction_status`;

export const dgepayCrypto = (): DgePayCrypto => new DgePayCrypto(DGEPAY_SECRET, DGEPAY_API_KEY);

/**
 * DGePay, with bodies encrypted and signed as its SDK does, and the
 * customer returning to redirect_url?data=<encrypted JSON>.
 */
export default class DgePayScenario extends GatewayScenario {
  readonly gateway = 'dgepay';

  config(): GatewayConfig {
    return {
      driver: 'dgepay',
      clientId: 'dgepay-client',
      clientSecret: DGEPAY_SECRET,
      apiKey: DGEPAY_API_KEY,
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      [DGEPAY_AUTH]: () =>
        reply({
          status_code: 200,
          success: 1,
          data: {
            access_token: 'dgepay.jwt.token',
            expiry_time: new Date(Date.now() + 3600_000).toISOString().slice(0, 19).replace('T', ' '),
          },
          error: [],
        }),

      [DGEPAY_INITIATE]: async ({ text }) => {
        const body = (await dgepayCrypto().decrypt(text)) ?? {};

        return reply({
          status_code: 200,
          success: 1,
          data: {
            webview_url: `https://pay-uat.dgepay.net/checkout/${String(body.unique_txn_id ?? '')}`,
            unique_txn_id: body.unique_txn_id ?? null,
          },
          error: [],
        });
      },

      [DGEPAY_STATUS]: this.verification(async ({ text }) => {
        const body = (await dgepayCrypto().decrypt(text)) ?? {};
        const payment = await this.payment('gatewayReference', body.unique_txn_id ?? '');

        return reply({
          status_code: 200,
          data: {
            message:
              this.state === 'paid'
                ? 'TRANSACTION SUCCESSFUL'
                : this.state === 'failed'
                  ? 'TRANSACTION FAILED'
                  : 'TRANSACTION INITIATED',
            txn_id: `TXN${payment.gatewayReference}`,
            status_code: this.state === 'paid' ? '3' : this.state === 'failed' ? '4' : '1',
            amount: Number(this.reported(payment)),
            created_date: Math.floor(Date.now() / 1000),
            txn_number: '50534914',
            payment_method: 'bKash',
            unique_txn_id: payment.gatewayReference,
          },
        });
      }),
    };
  }

  /** What DGePay appends to redirect_url: ?data=<encrypted JSON>. */
  redirect(payment: Payment, fields: JsonObject = {}): CallbackSpec {
    return get('/bdpaygate/dgepay/callback', {
      data: encryptedSync({
        status_code: '3',
        unique_txn_id: payment.gatewayReference,
        txn_number: '50534914',
        txn_id: `TXN${payment.gatewayReference}`,
        payment_method: 'bKash',
        amount: Number(payment.amount),
        third_party_txn_number: 'BK123',
        ...fields,
      }),
    });
  }

  successCallback(payment: Payment): CallbackSpec {
    return this.redirect(payment);
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return this.redirect(payment, { status_code: '8', message: 'TRANSACTION CANCELLED' });
  }
}

/**
 * The scenario's callbacks are built synchronously, so encrypt with
 * node:crypto directly, exactly as DgePayCrypto does.
 */
function encryptedSync(payload: JsonObject): string {
  const json = dgepayCrypto().json(payload);
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(DGEPAY_SECRET.padEnd(16, '0').slice(0, 16)), null);

  return cipher.update(json, 'utf8', 'base64') + cipher.final('base64');
}
