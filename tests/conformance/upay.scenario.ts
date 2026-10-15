import type { GatewayConfig, JsonObject, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

export const BASE = 'uat-pg.upay.systems';

export default class UpayScenario extends GatewayScenario {
  readonly gateway = 'upay';

  /** How the simulated Upay answers a refund: "success", "under_process" or "rejected". */
  refund: 'success' | 'under_process' | 'rejected' = 'success';

  config(): GatewayConfig {
    return {
      driver: 'upay',
      merchantId: '1110101010000001',
      merchantKey: 'test-merchant-key',
      merchantCode: '1234',
      merchantName: 'Test Shop',
      merchantMobile: '01700000000',
      merchantCity: 'Dhaka',
      merchantCategoryCode: '5999',
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      [`${BASE}/payment/merchant-auth/`]: () =>
        reply({
          code: 'MAS2001',
          message: 'Merchant authorization successful',
          lang: 'en',
          data: { token: 'JWT-TEST-TOKEN' },
        }),

      [`${BASE}/payment/merchant-payment-init/`]: ({ data }) => this.initiated(data),

      [`${BASE}/payment/single-payment-status/*`]: this.verification(async ({ url }) => {
        const txnId = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
        const payment = await this.store.findBy('upay', 'gatewayReference', txnId);

        if (!payment) {
          return reply({ code: 'PNF4012', message: 'Payment not found', lang: 'en', data: null }, 404);
        }

        return reply({
          code: 'PS2005',
          message: 'Payment status',
          lang: 'en',
          data: {
            txn_id: payment.gatewayReference,
            trx_id: `01JUPAY${payment.gatewayReference}`,
            invoice_id: payment.gatewayReference,
            session_id: `SESS${payment.gatewayReference}`,
            status: this.state === 'paid' ? 'success' : this.state === 'failed' ? 'failed' : 'pending',
            // A JSON number, as Upay sends it.
            amount: Number(this.reported(payment)),
            merchant_name: 'Test Shop',
            customer_wallet: '017****0000',
            date: '2026-10-15',
          },
        });
      }),

      [`${BASE}/payment/bulk/refund/`]: ({ text }) => {
        const entries: unknown = JSON.parse(text);
        const first: unknown = Array.isArray(entries) ? entries[0] : null;
        const txnId =
          first !== null && typeof first === 'object' && 'txn_id' in first ? String(first.txn_id) : '';

        return reply({
          code: 'MPR_200',
          message: 'Refund request processed',
          lang: 'en',
          data:
            this.refund === 'success'
              ? { success_list: [txnId], failed_list: {} }
              : this.refund === 'under_process'
                ? {
                    success_list: [],
                    failed_list: {
                      [txnId]: {
                        en: 'Your request is under process. Please, wait for confirmation',
                        bn: '...',
                      },
                    },
                  }
                : { success_list: [], failed_list: { [txnId]: { en: 'Invalid amount', bn: '...' } } },
        });
      },
    };
  }

  /** The merchant-payment-init answer for a request. */
  initiated(data: JsonObject): Response {
    return reply({
      code: 'MPIS2002',
      message: 'Merchant payment initiated successfully',
      lang: 'en',
      data: {
        session_id: `SESS${String(data.txn_id)}`,
        txn_id: data.txn_id,
        trx_id: `01JUPAY${String(data.txn_id)}`,
        invoice_id: data.invoice_id,
        merchant_id: data.merchant_id,
        gateway_url: `https://${BASE}/gateway/SESS${String(data.txn_id)}/`,
      },
    });
  }

  successCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/upay/callback', {
      txn: payment.gatewayReference,
      status: 'success',
      invoice_id: payment.gatewayReference,
    });
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/upay/callback', {
      txn: payment.gatewayReference,
      status: 'failed',
      invoice_id: payment.gatewayReference,
    });
  }
}
