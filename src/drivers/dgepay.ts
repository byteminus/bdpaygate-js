import { GatewayError, GatewayUnavailableError, InvalidCallbackError } from '../core/errors.js';
import { AbstractGateway } from '../core/gateway.js';
import type { HttpResponse } from '../core/http.js';
import type { CallbackRequest } from '../core/request.js';
import {
  type CallbackResult,
  type Capabilities,
  type ChargeOptions,
  type JsonObject,
  type Outcome,
  type Payment,
  PaymentStatus,
} from '../core/types.js';
import { isObject, jwtExpiry, limit, scalar } from '../core/util.js';
import { DgePayCrypto } from './dgepay-crypto.js';

/**
 * DGePay hosted checkout (bKash, Nagad and other wallets).
 *
 * EXPERIMENTAL. DGePay's API guide is only given to merchants; this driver is
 * built from DGePay's published SDK. Requests are authenticated with a JWT
 * (Basic auth on /payment_gateway/authenticate), their JSON body is
 * AES-128-ECB encrypted with the client secret, and a "Signature" header
 * carries an HMAC-SHA256 of the canonical payload (see DgePayCrypto).
 *
 * The customer comes back to redirect_url?data=<encrypted JSON>. That blob is
 * only decrypted to learn which payment it is about; the outcome always comes
 * from check_transaction_status.
 *
 * Config: clientId, clientSecret, apiKey, sandbox, baseUrl,
 * failedStatusCodes (default ["4"]), tokenTtl (seconds, when the JWT has no exp; default 300).
 */
export class DgePayGateway extends AbstractGateway {
  static override readonly driver = 'dgepay';

  static readonly SANDBOX_URL = 'https://api-uat.dgepay.net/dipon/v3';
  static readonly LIVE_URL = 'https://apiv2.dgepay.net/dipon/v3';

  /** DGePay's development host; set it as `baseUrl` if DGePay gives you DEV credentials. */
  static readonly DEV_URL = 'https://api-dev.dgepay.net/dipon/v3';

  static readonly STATUS_SUCCESS = '3';
  static readonly STATUS_CANCELLED = '8';

  override readonly capabilities: Capabilities = { sync: true, refunds: false };

  get baseUrl(): string {
    return this.endpoint(DgePayGateway.SANDBOX_URL, DgePayGateway.LIVE_URL);
  }

  get crypto(): DgePayCrypto {
    return new DgePayCrypto(this.credential('clientSecret'), this.credential('apiKey'), this.name);
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    if (this.currency !== 'BDT') {
      throw new GatewayError('DGePay only accepts BDT.', this.name);
    }

    const payment = await this.createPendingPayment(options);
    const meta = options.meta ?? {};

    const payload: JsonObject = {
      amount: Number(payment.amount),
      customer_token: null,
      note: limit(options.description ?? payment.reference, 100),
      payment_method: scalar(meta.paymentMethod ?? meta.payment_method),
      redirect_url: this.callbackUrl('callback'),
      unique_txn_id: payment.gatewayReference,
    };

    const phone = localPhone(options.customer.phone ?? '');

    if (phone) {
      payload.payee_information = { dial_code: '+88', phone_number: phone };
    }

    const response = await this.api('/payment_gateway/initiate_payment', payload);
    const data = response.data;
    const url = isObject(data.data) ? data.data.webview_url : null;

    this.log(payment, 'create', data);

    if (!response.ok || !this.ok(data) || typeof url !== 'string' || url === '') {
      await this.save(payment);

      throw new GatewayError(
        `DGePay could not initiate the payment: ${this.error(data, response)}`,
        this.name,
        data,
      );
    }

    payment.checkoutUrl = url;

    return this.save(payment);
  }

  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const encoded = request.all().data;
    const claim = typeof encoded === 'string' && encoded !== '' ? await this.crypto.decrypt(encoded) : null;

    if (claim === null) {
      throw new InvalidCallbackError(
        'DGePay callback has no data that decrypts with this client secret.',
        this.name,
        request.all(),
      );
    }

    const payment = await this.findByGatewayReference(scalar(claim.unique_txn_id) ?? '');

    return this.confirm(payment, outcome, claim);
  }

  override async sync(payment: Payment): Promise<Payment> {
    await this.confirm(payment, 'sync');

    return this.reload(payment);
  }

  /**
   * Ask check_transaction_status and apply the answer. Anything other than
   * a known success, cancel or failure code leaves the payment pending.
   *
   * @param claim The decrypted redirect payload, kept for the log.
   */
  private async confirm(payment: Payment, step: string, claim: JsonObject = {}): Promise<CallbackResult> {
    if (this.isPaid(payment)) {
      return this.unchanged(payment);
    }

    const response = await this.api('/payment_gateway/check_transaction_status', {
      unique_txn_id: payment.gatewayReference,
    });
    const body = response.data;
    const raw = Object.keys(claim).length === 0 || 'callback' in body ? body : { ...body, callback: claim };

    if (response.status >= 500) {
      throw new GatewayUnavailableError(
        `DGePay status API answered HTTP ${response.status}.`,
        this.name,
        raw,
      );
    }

    const data = isObject(body.data) ? body.data : null;

    if (!response.ok || data === null) {
      return this.stillPending(payment, step, raw);
    }

    if (
      data.unique_txn_id !== undefined &&
      data.unique_txn_id !== null &&
      scalar(data.unique_txn_id) !== payment.gatewayReference
    ) {
      throw new InvalidCallbackError('DGePay status API returned a different unique_txn_id.', this.name, raw);
    }

    const code = scalar(data.status_code) ?? '';

    if (code === DgePayGateway.STATUS_SUCCESS) {
      this.assertAmountMatches(payment, scalar(data.amount));

      const attributes: Partial<Payment> = {};
      const txnId = scalar(data.txn_id);
      const txnNumber = scalar(data.txn_number);

      if (truthy(txnId)) {
        attributes.gatewayPaymentId = txnId;
      }

      if (truthy(txnNumber)) {
        attributes.gatewayTransactionId = txnNumber;
      }

      return this.transition(payment, PaymentStatus.Completed, attributes, step, raw);
    }

    if (code === DgePayGateway.STATUS_CANCELLED || this.failedCodes().includes(code)) {
      const message = scalar(data.message);

      return this.transition(
        payment,
        code === DgePayGateway.STATUS_CANCELLED ? PaymentStatus.Cancelled : PaymentStatus.Failed,
        { failureReason: message === null ? null : limit(message, 255) },
        step,
        raw,
      );
    }

    return this.stillPending(payment, step, raw);
  }

  /** The status codes that mean a definite failure. */
  private failedCodes(): string[] {
    const configured = this.config.failedStatusCodes ?? ['4'];
    const codes: unknown[] = Array.isArray(configured) ? configured : [configured];

    return codes.map((code) => scalar(code) ?? '');
  }

  /**
   * An authenticated, signed, encrypted call. A 401 means the cached token
   * expired: fetch a new one and try once more (the request was rejected, not run).
   */
  private async api(path: string, payload: JsonObject): Promise<HttpResponse> {
    const crypto = this.crypto;
    const body = await crypto.encrypt(payload);
    const signature = await crypto.sign(payload);

    const call = async (): Promise<HttpResponse> =>
      this.http(this.baseUrl + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.token()}`,
          signature,
          'content-type': 'application/json',
        },
        body,
      });

    let response = await call();

    if (response.status === 401) {
      await this.forgetToken(this.tokenKey());
      response = await call();
    }

    return response;
  }

  /** A JWT from /payment_gateway/authenticate, cached until it expires. */
  async token(): Promise<string> {
    return this.rememberToken(this.tokenKey(), async () => {
      const id = this.credential('clientId');
      const secret = this.credential('clientSecret');

      const response = await this.http(`${this.baseUrl}/payment_gateway/authenticate`, {
        method: 'POST',
        headers: { authorization: `Basic ${base64(`${id}:${secret}`)}` },
        json: { client_id: id, client_secret: secret },
      });

      const data = response.data;
      const token = isObject(data.data) ? data.data.access_token : null;

      if (!response.ok || !this.ok(data) || typeof token !== 'string' || token === '') {
        throw new GatewayError(
          `DGePay authentication failed: ${this.error(data, response)}`,
          this.name,
          data,
        );
      }

      return [token, this.tokenTtl(token)];
    });
  }

  private tokenKey(): string {
    return `dgepay:${this.option('clientId')}`;
  }

  /** Seconds to cache a token: until the JWT's exp claim, less a minute. */
  private tokenTtl(token: string): number {
    const expires = jwtExpiry(token);

    return expires === null
      ? phpInt(this.config.tokenTtl ?? 300)
      : Math.max(30, expires - Math.floor(Date.now() / 1000) - 60);
  }

  /** Errors come back with HTTP 200, "success": 0 and an "error" list. */
  private ok(data: JsonObject): boolean {
    if ('success' in data && phpInt(data.success) !== 1) {
      return false;
    }

    return data.status_code === undefined || data.status_code === null || phpInt(data.status_code) === 200;
  }

  private error(data: JsonObject, response: HttpResponse): string {
    const error = data.error;
    const first = Array.isArray(error) ? error[0] : isObject(error) ? Object.values(error)[0] : error;

    for (const message of [first, data.message]) {
      const text = scalar(message);

      if (text !== null && text !== '') {
        return text;
      }
    }

    return `HTTP ${response.status}`;
  }
}

/** "01711000000" from "+8801711000000", "8801711000000" or "01711000000"; null otherwise. */
function localPhone(phone: string): string | null {
  let digits = phone.replace(/\D+/g, '');

  if (digits.length === 13 && digits.startsWith('88')) {
    digits = digits.slice(2);
  }

  return /^01\d{9}$/.test(digits) ? digits : null;
}

/** What PHP's array_filter() keeps. */
function truthy(value: string | null): value is string {
  return value !== null && value !== '' && value !== '0';
}

/** PHP's (int) cast, for the values a JSON body can hold. */
function phpInt(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);

    return Number.isNaN(parsed) ? 0 : parsed;
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? 1 : 0;
  }

  return isObject(value) ? 1 : 0;
}

/** Base64 of the UTF-8 bytes, as Basic auth sends them. */
function base64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}
