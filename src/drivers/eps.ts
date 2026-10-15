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
import { isObject, jwtExpiry, limit, nodeCrypto, scalar, sleep } from '../core/util.js';

type State = 'paid' | 'failed' | 'cancelled' | 'pending';

/** Status words EPS and its SDKs use, compared lowercase. */
const PAID = ['success', 'successful', 'succeeded', 'completed', 'complete', 'paid'];
const FAILED = ['failed', 'failure', 'fail', 'declined', 'rejected'];
const CANCELLED = ['cancel', 'canceled', 'cancelled', 'aborted', 'abort'];

/**
 * EPS (Easy Payment System) hosted checkout: cards, internet banking and most
 * wallets (bKash, Nagad, Rocket, OK Wallet, ...).
 *
 * EXPERIMENTAL. EPS publishes no API reference; this driver is built from
 * EPS's own SDKs on github.com/EPS-PG. Every call carries an "x-hash" header,
 * base64(HMAC-SHA512(hash key, value)), where the signed value depends on the
 * endpoint: the username for GetToken, the merchant transaction id for
 * InitializeEPS and CheckMerchantTransactionStatus.
 *
 * Nothing EPS sends to the browser is signed, and its IPN is encrypted with a
 * key whose format is undocumented. Every callback is therefore only a reason
 * to ask CheckMerchantTransactionStatus, which is the source of truth.
 *
 * Config: username, password, hashKey, merchantId, storeId, sandbox, baseUrl,
 * deviceTypeId, statusAttempts (default 3), statusRetryDelay (ms, default 1500),
 * ipnWindow (minutes, default 120), ipnSweepLimit (default 10),
 * tokenTtl (seconds, when EPS gives no expiry; default 300).
 */
export class EpsGateway extends AbstractGateway {
  static override readonly driver = 'eps';

  static readonly SANDBOX_URL = 'https://sandboxpgapi.eps.com.bd';
  static readonly LIVE_URL = 'https://pgapi.eps.com.bd';

  override readonly capabilities: Capabilities = { sync: true, refunds: false };

  get baseUrl(): string {
    return this.endpoint(EpsGateway.SANDBOX_URL, EpsGateway.LIVE_URL);
  }

  /** base64(HMAC-SHA512(hash key, value)): the x-hash header. */
  async hash(value: string): Promise<string> {
    const key = this.credential('hashKey');
    const { createHmac } = await nodeCrypto();

    return createHmac('sha512', key).update(value, 'utf8').digest('base64');
  }

  /**
   * EPS's SDKs send merchant transaction ids as digits only (at least 10).
   * Use 20 digits: a timestamp plus 8 random digits.
   */
  protected override async newGatewayReference(): Promise<string> {
    const { randomInt } = await nodeCrypto();
    const now = new Date();
    const two = (value: number): string => String(value).padStart(2, '0');
    const stamp =
      two(now.getUTCFullYear() % 100) +
      two(now.getUTCMonth() + 1) +
      two(now.getUTCDate()) +
      two(now.getUTCHours()) +
      two(now.getUTCMinutes()) +
      two(now.getUTCSeconds());

    return stamp + String(randomInt(0, 100_000_000)).padStart(8, '0');
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    if (this.currency !== 'BDT') {
      throw new GatewayError('EPS only accepts BDT.', this.name);
    }

    const payment = await this.createPendingPayment(options);
    const transactionId = payment.gatewayReference;
    const customer = options.customer;
    const city = customer.city ?? 'Dhaka';
    const meta = options.meta ?? {};
    const device = this.config.deviceTypeId;

    const body: JsonObject = {
      merchantId: this.credential('merchantId'),
      storeId: this.credential('storeId'),
      ...(typeof device === 'string' || typeof device === 'number' ? { deviceTypeId: device } : {}),
      // EPS's own plugin suffixes the order id per attempt; a retried reference must not collide.
      CustomerOrderId: `${limit(payment.reference, 40)}-${transactionId.slice(-6)}`,
      merchantTransactionId: transactionId,
      transactionTypeId: 1,
      financialEntityId: 0,
      transitionStatusId: 0,
      totalAmount: Number(payment.amount),
      ipAddress: payment.customer?.ip || scalar(meta.ipAddress ?? meta.ip_address) || '0.0.0.0',
      version: '1',
      transactionDate: iso8601(new Date()),
      successUrl: this.callbackUrl('success'),
      failUrl: this.callbackUrl('fail'),
      cancelUrl: this.callbackUrl('cancel'),
      customerName: customer.name,
      customerEmail: customer.email ?? 'noemail@example.com',
      CustomerAddress: customer.address ?? city,
      CustomerAddress2: '',
      CustomerCity: city,
      CustomerState: scalar(meta.state) ?? city,
      CustomerPostcode: payment.customer?.postcode || scalar(meta.postcode) || '1000',
      CustomerCountry: 'BD',
      CustomerPhone: customer.phone,
      ValueA: payment.id,
      ValueB: payment.reference,
      ShippingMethod: 'NO',
      NoOfItem: '1',
      ProductName: options.description ?? payment.reference,
      ProductProfile: scalar(meta.profile) ?? 'general',
      ProductCategory: scalar(meta.category) ?? 'general',
      ProductList: [],
    };

    const response = await this.api('POST', '/v1/EPSEngine/InitializeEPS', transactionId, body);
    const data = response.data;
    const redirect = pick(data, 'RedirectURL');

    this.log(payment, 'create', data);

    if (!response.ok || typeof redirect !== 'string' || redirect === '' || pick(data, 'ErrorCode') !== null) {
      await this.save(payment);

      throw new GatewayError(
        `EPS could not initialise the payment: ${scalar(pick(data, 'ErrorMessage')) ?? `HTTP ${response.status}`}`,
        this.name,
        data,
      );
    }

    payment.gatewayPaymentId = scalar(pick(data, 'TransactionId'));
    payment.checkoutUrl = redirect;

    return this.save(payment);
  }

  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const input = normaliseKeys(request.all());
    const transactionId = scalar(pick(input, 'MerchantTransactionId', 'merchant_transaction_id'));

    if (outcome === 'ipn' && transactionId === null) {
      return this.sweep(input);
    }

    const payment = await this.findByGatewayReference(transactionId ?? '');

    return this.confirm(payment, outcome, input);
  }

  override async sync(payment: Payment): Promise<Payment> {
    await this.confirm(payment, 'sync');

    return this.reload(payment);
  }

  /**
   * Ask EPS what happened and apply it. The redirect (or IPN) only decides
   * whether a confirmed non-payment reads as cancelled or failed.
   *
   * @param claim What the browser or IPN said, kept for the log.
   */
  private async confirm(
    payment: Payment,
    step: string,
    claim: JsonObject = {},
    retry = true,
  ): Promise<CallbackResult> {
    if (this.isPaid(payment)) {
      return this.unchanged(payment);
    }

    const [state, fields] = await this.status(payment, retry);
    const data =
      Object.keys(claim).length === 0 || 'callback' in fields ? fields : { ...fields, callback: claim };

    switch (state) {
      case 'paid':
        return this.complete(payment, data, step);
      case 'failed':
      case 'cancelled':
        return this.transition(
          payment,
          state === 'cancelled' || step === 'cancel' ? PaymentStatus.Cancelled : PaymentStatus.Failed,
          { failureReason: reason(data) },
          step,
          data,
        );
      default:
        return this.stillPending(payment, step, data);
    }
  }

  private async complete(payment: Payment, data: JsonObject, step: string): Promise<CallbackResult> {
    this.assertAmountMatches(payment, scalar(pick(data, 'TotalAmount', 'totalAmount', 'amount')));

    const epsId = scalar(pick(data, 'EpsTransactionId', 'EPSTransactionId', 'TransactionId'));
    const attributes: Partial<Payment> =
      epsId !== null && epsId !== '' && epsId !== '0'
        ? { gatewayPaymentId: epsId, gatewayTransactionId: epsId }
        : {};

    return this.transition(payment, PaymentStatus.Completed, attributes, step, data);
  }

  /**
   * CheckMerchantTransactionStatus by our merchant transaction id. EPS answers
   * 404 for a short while after a payment, so 404 is retried and then read as
   * "not known yet": pending, never failed.
   */
  private async status(payment: Payment, retry = true): Promise<[State, JsonObject]> {
    const attempts = retry ? Math.max(1, integer(this.config.statusAttempts, 3)) : 1;
    const delay = Math.max(0, integer(this.config.statusRetryDelay, 1500));

    const ask = (): Promise<HttpResponse> =>
      this.api('GET', '/v1/EPSEngine/CheckMerchantTransactionStatus', payment.gatewayReference, {
        merchantTransactionId: payment.gatewayReference,
      });

    let response = await ask();

    for (let attempt = 2; attempt <= attempts && response.status === 404; attempt++) {
      if (delay > 0) {
        await sleep(delay);
      }

      response = await ask();
    }

    const data = response.data;

    if (response.status >= 500) {
      throw new GatewayUnavailableError(`EPS status API answered HTTP ${response.status}.`, this.name, data);
    }

    if (!response.ok) {
      return ['pending', { http_status: response.status, ...data }];
    }

    // Some EPS samples nest the result under "data".
    const nested = pick(data, 'data');
    const fields = isObject(nested) ? { ...nested, ...data } : data;

    const reported = scalar(pick(fields, 'MerchantTransactionId', 'merchantTransactionId'));

    if (reported !== null && reported !== payment.gatewayReference) {
      throw new InvalidCallbackError(
        'EPS status API returned a different merchant transaction id.',
        this.name,
        data,
      );
    }

    const status = (scalar(pick(fields, 'Status', 'transactionStatus')) ?? '').trim().toLowerCase();
    const state: State = PAID.includes(status)
      ? 'paid'
      : CANCELLED.includes(status)
        ? 'cancelled'
        : FAILED.includes(status)
          ? 'failed'
          : 'pending';

    return [state, fields];
  }

  /**
   * An IPN that does not name the transaction in plain text (EPS encrypts it,
   * and we do not decrypt it). Use it as a nudge: ask EPS about this
   * gateway's recent pending payments.
   */
  private async sweep(input: JsonObject): Promise<CallbackResult> {
    const now = Date.now();
    const window = integer(this.config.ipnWindow, 120);
    const max = Math.max(1, integer(this.config.ipnSweepLimit, 10));

    const pending = await this.ctx.store.pending({
      gateway: this.name,
      createdAfter: new Date(now - window * 60_000),
      createdBefore: new Date(now),
      newestFirst: true,
      limit: max,
    });

    const latest = pending[0];

    if (!latest) {
      throw new InvalidCallbackError(
        'EPS IPN received, but no recent pending EPS payment to confirm.',
        this.name,
        input,
      );
    }

    // The IPN URL is public and this IPN is unauthenticated: sweep at most
    // once a minute, without 404 retries, so it cannot be used to make us
    // hammer EPS or hold workers. Anything missed is settled by syncPending().
    if (!(await this.ctx.cache.add(`bdpaygate:eps:sweep:${this.name}`, true, 60))) {
      return { payment: latest, status: PaymentStatus.Pending, changed: false };
    }

    const results: CallbackResult[] = [];

    for (const payment of pending) {
      try {
        results.push(await this.confirm(payment, 'ipn', {}, false));
      } catch (error) {
        if (error instanceof GatewayUnavailableError || !(error instanceof GatewayError)) {
          throw error;
        }

        // One bad answer (an amount mismatch, say) must not stop the others.
        this.ctx.logger.warn('BdPayGate could not confirm an EPS payment during an IPN sweep', {
          gateway: this.name,
          gatewayReference: payment.gatewayReference,
          reason: error.message,
        });
      }
    }

    return (
      results.find((result) => result.changed && result.status === PaymentStatus.Completed) ??
      results.find((result) => result.changed) ??
      results[0] ?? { payment: latest, status: PaymentStatus.Pending, changed: false }
    );
  }

  /**
   * A signed, authenticated EPS call. A 401 means the cached token expired:
   * fetch a new one and try once more (the request was rejected, not run).
   */
  private async api(
    method: 'GET' | 'POST',
    path: string,
    signed: string,
    data: JsonObject,
  ): Promise<HttpResponse> {
    const call = async (): Promise<HttpResponse> => {
      const headers = { 'x-hash': await this.hash(signed), authorization: `Bearer ${await this.token()}` };

      return method === 'GET'
        ? this.http(this.baseUrl + path, { method, headers, query: queryValues(data) })
        : this.http(this.baseUrl + path, { method, headers, json: data });
    };

    let response = await call();

    if (response.status === 401) {
      await this.forgetToken(this.tokenKey());
      response = await call();
    }

    return response;
  }

  /** A JWT from /v1/Auth/GetToken (x-hash signs the username), cached until it expires. */
  async token(): Promise<string> {
    return this.rememberToken(this.tokenKey(), async () => {
      const username = this.credential('username');

      const response = await this.http(`${this.baseUrl}/v1/Auth/GetToken`, {
        method: 'POST',
        headers: { 'x-hash': await this.hash(username) },
        json: { userName: username, password: this.credential('password') },
      });

      const data = response.data;
      const token = pick(data, 'token');

      if (typeof token !== 'string' || token === '') {
        throw new GatewayError(
          `EPS token request failed: ${scalar(pick(data, 'errorMessage')) ?? `HTTP ${response.status}`}`,
          this.name,
          data,
        );
      }

      return [token, this.tokenTtl(token, pick(data, 'expireDate'))];
    });
  }

  private tokenKey(): string {
    return `eps:${this.option('username')}:${this.option('merchantId')}`;
  }

  /** Seconds to cache a token: until expireDate (or the JWT's exp), less a minute. */
  private tokenTtl(token: string, expireDate: unknown): number {
    let expires: number | null = null;

    if (typeof expireDate === 'string' && expireDate !== '') {
      const parsed = Date.parse(expireDate);
      expires = Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
    }

    expires ??= jwtExpiry(token);

    return expires === null
      ? integer(this.config.tokenTtl, 300)
      : Math.max(30, expires - Math.floor(Date.now() / 1000) - 60);
  }
}

/**
 * A value by any of the given keys, ignoring case; null and "" count as missing.
 * EPS mixes PascalCase and camelCase and sends literal nulls.
 */
function pick(data: JsonObject, ...names: string[]): unknown {
  const lower = new Map<string, unknown>();

  for (const [key, value] of Object.entries(data)) {
    lower.set(key.toLowerCase(), value);
  }

  for (const name of names) {
    const value = lower.get(name.toLowerCase());

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return null;
}

/**
 * EPS sometimes HTML-escapes the separators it appends to return URLs,
 * leaving keys such as "amp;MerchantTransactionId".
 */
function normaliseKeys(input: JsonObject): JsonObject {
  const clean: JsonObject = {};

  for (const [key, value] of Object.entries(input)) {
    clean[key.replace(/^(amp;)+/i, '')] = value;
  }

  return clean;
}

function reason(data: JsonObject): string | null {
  const callback = isObject(data.callback) ? data.callback : {};
  const value = scalar(
    pick(data, 'ErrorMessage', 'Message') ?? pick(callback, 'Message', 'ErrorMessage', 'Status'),
  );

  return value === null ? null : limit(value, 255);
}

/** An integer config value, or the fallback when it is not set. */
function integer(value: unknown, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  const number = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);

  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function queryValues(data: JsonObject): Record<string, string> {
  const query: Record<string, string> = {};

  for (const [key, value] of Object.entries(data)) {
    const text = scalar(value);

    if (text !== null) {
      query[key] = text;
    }
  }

  return query;
}

/** Like PHP's toIso8601String(): 2026-10-15T12:00:00+00:00. */
function iso8601(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}
