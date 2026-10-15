import * as nodeCrypto from 'node:crypto';
import { constants, createSign, createVerify, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { rsaPkcs1v15Decrypt } from '../../src/drivers/nagad-crypto.js';
import type { GatewayConfig, JsonObject, Payment } from '../../src/index.js';
import { type MockRequest, type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get } from '../support/scenario.js';

export const MERCHANT_ID = '683002007104225';

export const BASE = 'sandbox-ssl.mynagad.com/remote-payment-gateway-1.0/api/dfs';

export interface NagadKeys {
  merchantPrivate: string;
  merchantPublic: string;
  nagadPrivate: string;
  nagadPublic: string;
}

let generated: NagadKeys | null = null;

/** Two throwaway RSA-2048 pairs: the merchant's and "Nagad's". */
export function keys(): NagadKeys {
  if (generated) {
    return generated;
  }

  const pair = () =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

  const merchant = pair();
  const nagad = pair();

  generated = {
    merchantPrivate: merchant.privateKey,
    merchantPublic: merchant.publicKey,
    nagadPrivate: nagad.privateKey,
    nagadPublic: nagad.publicKey,
  };

  return generated;
}

/** Encrypt a response for the merchant and sign it as Nagad. */
export function seal(
  data: JsonObject,
  algorithm: 'sha256' | 'sha1' = 'sha256',
): { sensitiveData: string; signature: string } {
  const plain = JSON.stringify(data);
  const encrypted = publicEncrypt(
    { key: keys().merchantPublic, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plain),
  );
  const signature = createSign(algorithm).update(plain).sign(keys().nagadPrivate);

  return { sensitiveData: encrypted.toString('base64'), signature: signature.toString('base64') };
}

/** The last path segment of a stubbed request. */
export const lastSegment = (request: MockRequest): string =>
  decodeURIComponent(request.url.pathname.split('/').pop() ?? '');

/**
 * A simulated Nagad. Key pairs are generated per test run with node:crypto and
 * thrown away; no real Nagad keys are used or stored.
 */
export default class NagadScenario extends GatewayScenario {
  readonly gateway = 'nagad';

  /** The signature algorithm the simulated Nagad verifies requests with. */
  algorithm: 'sha256' | 'sha1' = 'sha256';

  config(): GatewayConfig {
    return {
      driver: 'nagad',
      merchantId: MERCHANT_ID,
      publicKey: keys().nagadPublic,
      privateKey: keys().merchantPrivate,
      sandbox: true,
      verifyResponseSignature: true,
    };
  }

  /**
   * What Nagad does with a request's sensitiveData: decrypt with its private key
   * and check the merchant's signature with the merchant public key.
   */
  readSensitive(request: MockRequest): JsonObject {
    const plain = rsaPkcs1v15Decrypt(
      nodeCrypto,
      keys().nagadPrivate,
      Buffer.from(String(request.data.sensitiveData), 'base64'),
    ).toString('utf8');

    const verified = createVerify(this.algorithm)
      .update(plain)
      .verify(keys().merchantPublic, Buffer.from(String(request.data.signature), 'base64'));

    if (!verified) {
      throw new Error('Simulated Nagad: request signature does not verify.');
    }

    return JSON.parse(plain) as JsonObject;
  }

  routes(): Routes {
    return {
      [`${BASE}/check-out/initialize/*`]: (request) => {
        const plain = this.readSensitive(request);

        return reply(
          seal(
            {
              paymentReferenceId: `MDREF${String(plain.orderId)}`,
              challenge: plain.challenge,
              acceptDateTime: plain.datetime,
            },
            this.algorithm,
          ),
        );
      },

      [`${BASE}/check-out/complete/*`]: (request) => {
        this.readSensitive(request);

        return reply({
          callBackUrl: `https://sandbox-ssl.mynagad.com:10061/check-out/${lastSegment(request)}`,
          status: 'Success',
        });
      },

      [`${BASE}/verify/payment/*`]: this.verification(async (request) => {
        const payment = await this.store.findBy('nagad', 'gatewayPaymentId', lastSegment(request));

        if (!payment) {
          return reply({ reason: '16_0004_999', message: 'Please verify provided data and try again' }, 404);
        }

        return reply(
          this.verifyBody(
            payment,
            this.state === 'paid' ? 'Success' : this.state === 'failed' ? 'Aborted' : 'OtpSent',
          ),
        );
      }),
    };
  }

  verifyBody(payment: Payment, status: string): JsonObject {
    const paid = status === 'Success';

    return {
      merchantId: MERCHANT_ID,
      orderId: payment.gatewayReference,
      paymentRefId: payment.gatewayPaymentId,
      // Nagad sends amounts as strings with no fixed format ("150", "150.00").
      amount: this.reported(payment).replace(/\.00$/, ''),
      clientMobileNo: '017****0000',
      merchantMobileNo: '01700000000',
      orderDateTime: '2026-10-15 12:00:00.0',
      issuerPaymentDateTime: paid ? '2026-10-15 12:01:00.0' : null,
      issuerPaymentRefNo: paid ? `ISS${payment.gatewayReference.slice(2, 10)}` : null,
      additionalMerchantInfo: { reference: payment.reference },
      status,
      statusCode: paid ? '000' : '001',
    };
  }

  successCallback(payment: Payment): CallbackSpec {
    return this.callback(payment, 'Success', '00_0000_000', 'Successful Transaction');
  }

  override failureCallback(payment: Payment): CallbackSpec {
    return this.callback(payment, 'Aborted', '01_0000_000', 'Aborted by user');
  }

  protected callback(payment: Payment, status: string, code: string, message: string): CallbackSpec {
    return get('/bdpaygate/nagad/callback', {
      merchant: MERCHANT_ID,
      order_id: payment.gatewayReference,
      payment_ref_id: String(payment.gatewayPaymentId ?? ''),
      status,
      status_code: code,
      message,
      payment_dt: '20261015120100',
      issuer_payment_ref: `ISS${payment.gatewayReference.slice(2, 10)}`,
    });
  }
}
