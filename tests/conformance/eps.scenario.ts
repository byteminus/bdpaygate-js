import type { GatewayConfig, Payment } from '../../src/index.js';
import { type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

export const EPS_HOST = 'sandboxpgapi.eps.com.bd';
export const EPS_TOKEN = `${EPS_HOST}/v1/Auth/GetToken`;
export const EPS_INIT = `${EPS_HOST}/v1/EPSEngine/InitializeEPS`;
export const EPS_STATUS = `${EPS_HOST}/v1/EPSEngine/CheckMerchantTransactionStatus*`;

/**
 * EPS, with response shapes from EPS's own SDKs: PascalCase fields, literal
 * nulls, a status API queried by merchant transaction id.
 */
export default class EpsScenario extends GatewayScenario {
  readonly gateway = 'eps';

  config(): GatewayConfig {
    return {
      driver: 'eps',
      username: 'eps-user',
      password: 'eps-pass',
      hashKey: 'eps-hash-key',
      merchantId: 'MID-1',
      storeId: 'SID-1',
      sandbox: true,
      statusRetryDelay: 0,
    };
  }

  routes(): Routes {
    return {
      [EPS_TOKEN]: () =>
        reply({
          token: 'eps.jwt.token',
          expireDate: new Date(Date.now() + 3600_000).toISOString(),
          errorMessage: null,
          errorCode: null,
        }),

      [EPS_INIT]: ({ data }) =>
        reply({
          TransactionId: `EPS${String(data.merchantTransactionId)}`,
          RedirectURL: `https://sandboxpg.eps.com.bd/PG?data=${String(data.merchantTransactionId)}`,
          ErrorMessage: null,
          ErrorCode: null,
          FinancialEntityList: null,
        }),

      [EPS_STATUS]: this.verification(async ({ url }) => {
        const payment = await this.payment('gatewayReference', url.searchParams.get('merchantTransactionId'));

        return reply({
          MerchantTransactionId: payment.gatewayReference,
          EpsTransactionId: `EPS${payment.gatewayReference}`,
          Status: this.state === 'paid' ? 'Success' : this.state === 'failed' ? 'Failed' : 'Pending',
          TotalAmount: this.reported(payment),
          StoreAmount: null,
          FinancialEntity: 'BKash',
          PaymentReferance: null,
          ErrorCode: null,
          ErrorMessage: null,
        });
      }),
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/eps/success', {
      Status: 'Success',
      MerchantTransactionId: payment.gatewayReference,
      ErrorCode: '',
      EPSTransactionId: `EPS${payment.gatewayReference}`,
    });
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/eps/fail', {
      Status: 'Failed',
      MerchantTransactionId: payment.gatewayReference,
      ErrorCode: '101',
      Message: 'Declined by bank',
    });
  }
}
