import type { GatewayConfig } from './gateway.js';

type Env = Record<string, string | undefined>;

/** env var -> config key, per gateway. The same names as the Laravel package, so one .env serves both. */
const ENV_MAP: Record<string, Record<string, string>> = {
  bkash: {
    BKASH_APP_KEY: 'appKey',
    BKASH_APP_SECRET: 'appSecret',
    BKASH_USERNAME: 'username',
    BKASH_PASSWORD: 'password',
    BKASH_VERSION: 'version',
  },
  sslcommerz: { SSLCOMMERZ_STORE_ID: 'storeId', SSLCOMMERZ_STORE_PASSWORD: 'storePassword' },
  shurjopay: { SHURJOPAY_USERNAME: 'username', SHURJOPAY_PASSWORD: 'password', SHURJOPAY_PREFIX: 'prefix' },
  aamarpay: { AAMARPAY_STORE_ID: 'storeId', AAMARPAY_SIGNATURE_KEY: 'signatureKey' },
  nagad: {
    NAGAD_MERCHANT_ID: 'merchantId',
    NAGAD_MERCHANT_NUMBER: 'merchantNumber',
    NAGAD_PUBLIC_KEY: 'publicKey',
    NAGAD_PRIVATE_KEY: 'privateKey',
    NAGAD_BASE_URL: 'baseUrl',
    NAGAD_SIGNATURE_ALGORITHM: 'signatureAlgorithm',
    NAGAD_VERIFY_RESPONSE_SIGNATURE: 'verifyResponseSignature',
    NAGAD_IP: 'ip',
  },
  upay: {
    UPAY_MERCHANT_ID: 'merchantId',
    UPAY_MERCHANT_KEY: 'merchantKey',
    UPAY_MERCHANT_CODE: 'merchantCode',
    UPAY_MERCHANT_NAME: 'merchantName',
    UPAY_MERCHANT_MOBILE: 'merchantMobile',
    UPAY_MERCHANT_CITY: 'merchantCity',
    UPAY_MERCHANT_CATEGORY_CODE: 'merchantCategoryCode',
    UPAY_BASE_URL: 'baseUrl',
  },
  portpos: { PORTPOS_APP_KEY: 'appKey', PORTPOS_SECRET_KEY: 'secretKey' },
  paystation: { PAYSTATION_MERCHANT_ID: 'merchantId', PAYSTATION_PASSWORD: 'password' },
  uddoktapay: { UDDOKTAPAY_BASE_URL: 'baseUrl', UDDOKTAPAY_API_KEY: 'apiKey' },
  moneybag: { MONEYBAG_API_KEY: 'apiKey', MONEYBAG_BASE_URL: 'baseUrl' },
  eps: {
    EPS_USERNAME: 'username',
    EPS_PASSWORD: 'password',
    EPS_HASH_KEY: 'hashKey',
    EPS_MERCHANT_ID: 'merchantId',
    EPS_STORE_ID: 'storeId',
  },
  dgepay: { DGEPAY_CLIENT_ID: 'clientId', DGEPAY_CLIENT_SECRET: 'clientSecret', DGEPAY_API_KEY: 'apiKey' },
};

const truthy = (value: string): boolean =>
  !['false', '0', 'no', 'off', ''].includes(value.trim().toLowerCase());

/**
 * Gateway configs from environment variables, for every gateway that has
 * at least one of its variables set. `<GATEWAY>_SANDBOX` defaults to true
 * (UddoktaPay: false, it is self-hosted).
 *
 *     createBdPayGate({ baseUrl: process.env.APP_URL, gateways: gatewaysFromEnv(process.env) })
 */
export function gatewaysFromEnv(env: Env): Record<string, GatewayConfig> {
  const gateways: Record<string, GatewayConfig> = {};

  for (const [gateway, map] of Object.entries(ENV_MAP)) {
    const config: GatewayConfig = { driver: gateway };
    let present = false;

    for (const [variable, key] of Object.entries(map)) {
      const value = env[variable];

      if (value !== undefined && value !== '') {
        // PEM keys pasted on one line with literal \n.
        config[key] = key === 'verifyResponseSignature' ? truthy(value) : value.replace(/\\n/g, '\n');
        present = true;
      }
    }

    if (!present) {
      continue;
    }

    const sandbox = env[`${gateway.toUpperCase()}_SANDBOX`];
    config.sandbox = sandbox === undefined ? gateway !== 'uddoktapay' : truthy(sandbox);
    gateways[gateway] = config;
  }

  return gateways;
}
