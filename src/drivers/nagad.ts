import { GatewayError, InvalidCallbackError } from '../core/errors.js';
import { AbstractGateway } from '../core/gateway.js';
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
import { isObject, limit, nodeCrypto } from '../core/util.js';
import { NagadCrypto } from './nagad-crypto.js';

/** ISO 4217 numeric code for BDT, as Nagad expects it. */
const CURRENCY_CODE = '050';

const PAID = 'success';

const CANCELLED = ['cancelled', 'aborted'];

const FAILED = ['failed', 'fraud', 'invalidrequest', 'unknownfailed'];

/**
 * Nagad Online Payment API (hosted checkout, API version v-0.2.0).
 *
 * BETA: built from public information and not yet verified against a merchant
 * sandbox. Nagad hands out its integration guide at onboarding; check this
 * driver against it.
 *
 * Flow: initialize (RSA-encrypted, signed) -> complete -> redirect the customer
 * -> unsigned browser callback -> GET verify/payment/{paymentRefId}. Nagad
 * publishes no refund API, so refunds go through the merchant portal.
 *
 * Config: merchantId, publicKey (Nagad's), privateKey (the merchant's),
 * merchantNumber, signatureAlgorithm (sha256 or sha1, default sha256),
 * verifyResponseSignature (default false), ip (the whitelisted server IPv4,
 * sent when the customer's is not usable), locale (EN or BN), clientType
 * (default PC_WEB), apiVersion, sandbox. Nagad whitelists server IPs: pass a
 * `fetch` with a proxy dispatcher when your server's IP is not the one
 * registered.
 *
 * Charge meta: `customerIp` (the customer's IPv4) and `additionalMerchantInfo`
 * (an object sent to Nagad alongside the reference).
 */
export class NagadGateway extends AbstractGateway {
  static override readonly driver = 'nagad';

  static readonly SANDBOX_URL = 'https://sandbox-ssl.mynagad.com/remote-payment-gateway-1.0/api/dfs';
  static readonly LIVE_URL = 'https://api.mynagad.com/api/dfs';
  static readonly API_VERSION = 'v-0.2.0';

  override readonly capabilities: Capabilities = { sync: true, refunds: false };

  private cryptoHelper: NagadCrypto | null = null;

  get baseUrl(): string {
    return this.endpoint(NagadGateway.SANDBOX_URL, NagadGateway.LIVE_URL);
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    if (this.currency !== 'BDT') {
      throw new GatewayError('Nagad only accepts BDT.', this.name);
    }

    const merchantId = this.credential('merchantId');
    const crypto = this.crypto();
    const payment = await this.createPendingPayment(options);
    const orderId = payment.gatewayReference;

    // Nagad order ids: 5 to 20 letters and digits, unique per day.
    if (!/^[A-Za-z0-9]{5,20}$/.test(orderId)) {
      throw new GatewayError(`Nagad order id [${orderId}] must be 5 to 20 letters or digits.`, this.name);
    }

    const meta = options.meta ?? {};
    const customerIp = options.customer.ip ?? meta.customerIp ?? meta.customer_ip;
    const ip = this.clientIp(typeof customerIp === 'string' ? customerIp : null);

    // Step 1: initialize. The sensitive JSON must stay small (RSA-2048 fits 245 bytes).
    const { randomBytes } = await nodeCrypto();
    const challenge = randomBytes(20).toString('hex');
    const dateTime = dhakaTime();
    let sensitive = JSON.stringify({ merchantId, datetime: dateTime, orderId, challenge });

    const body: JsonObject = {};
    const accountNumber = this.option('merchantNumber');

    if (accountNumber !== '') {
      body.accountNumber = accountNumber;
    }

    body.dateTime = dateTime;
    body.sensitiveData = await crypto.encrypt(sensitive);
    body.signature = await crypto.sign(sensitive);

    const locale = this.option('locale', 'EN').toUpperCase() === 'BN' ? 'BN' : 'EN';
    let response = await this.http(
      `${this.baseUrl}/check-out/initialize/${merchantId}/${orderId}?locale=${locale}`,
      { method: 'POST', headers: this.headers(ip), json: body },
    );
    let data = response.data;

    if (!response.ok || typeof data.sensitiveData !== 'string') {
      await this.save(this.log(payment, 'initialize', data));

      throw new GatewayError(
        `Nagad could not initialize the payment: ${errorMessage(data, response.status)}`,
        this.name,
        data,
      );
    }

    const initialized = await this.open(data);
    const paymentRefId = scalar(initialized.paymentReferenceId) ?? '';

    if (paymentRefId === '') {
      await this.save(this.log(payment, 'initialize', initialized));

      throw new GatewayError('Nagad did not return a paymentReferenceId.', this.name, initialized);
    }

    // Saved before completing: verify only works by paymentRefId, so a
    // lost response after this point can still be reconciled by sync.
    payment.gatewayPaymentId = paymentRefId;
    await this.save(this.log(payment, 'initialize', initialized));

    // Step 2: complete (place the order) with the challenge from step 1.
    sensitive = JSON.stringify({
      merchantId,
      orderId,
      amount: payment.amount,
      currencyCode: CURRENCY_CODE,
      challenge: scalar(initialized.challenge) ?? challenge,
    });

    const extra = meta.additionalMerchantInfo ?? meta.additional_merchant_info;
    const additional = { ...(isObject(extra) ? extra : {}), reference: payment.reference };

    response = await this.http(`${this.baseUrl}/check-out/complete/${encodeURIComponent(paymentRefId)}`, {
      method: 'POST',
      headers: this.headers(ip),
      json: {
        sensitiveData: await crypto.encrypt(sensitive),
        signature: await crypto.sign(sensitive),
        merchantCallbackURL: this.callbackUrl('callback'),
        additionalMerchantInfo: additional,
      },
    });
    data = response.data;
    const checkoutUrl = data.callBackUrl;

    if (
      !response.ok ||
      (scalar(data.status) ?? '').toLowerCase() !== 'success' ||
      typeof checkoutUrl !== 'string' ||
      checkoutUrl === ''
    ) {
      await this.save(this.log(payment, 'complete', data));

      throw new GatewayError(
        `Nagad could not place the order: ${errorMessage(data, response.status)}`,
        this.name,
        data,
      );
    }

    payment.checkoutUrl = checkoutUrl;

    return this.save(this.log(payment, 'complete', data));
  }

  /**
   * Nagad returns the customer with a GET to merchantCallbackURL. The query
   * (status, payment_ref_id, ...) is unsigned, so it only says which payment
   * to look at; the verify API decides what happened.
   */
  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const orderId = request.string('order_id');
    const paymentRefId = request.string('payment_ref_id');

    const payment =
      orderId !== ''
        ? await this.findByGatewayReference(orderId)
        : await this.findByGatewayPaymentId(paymentRefId);

    if (this.isPaid(payment)) {
      return this.unchanged(payment);
    }

    return this.verify(payment, outcome, paymentRefId, request.ip);
  }

  override async sync(payment: Payment): Promise<Payment> {
    if (payment.gatewayPaymentId) {
      await this.verify(payment, 'sync');
    }

    return this.reload(payment);
  }

  /**
   * Ask Nagad what happened to a payment and apply it. Anything that is not a
   * clear answer leaves the payment pending.
   */
  private async verify(
    payment: Payment,
    step: string,
    claimedRefId = '',
    ip: string | null = null,
  ): Promise<CallbackResult> {
    // Prefer the id we stored over whatever the callback claims.
    const refId = payment.gatewayPaymentId || claimedRefId;

    if (refId === '') {
      return this.stillPending(payment, step, { reason: 'No Nagad paymentRefId to verify yet.' });
    }

    const response = await this.http(`${this.baseUrl}/verify/payment/${encodeURIComponent(refId)}`, {
      method: 'GET',
      headers: this.headers(this.clientIp(ip)),
    });
    const data = response.data;

    // 404 + 16_0004_999: Nagad has no such payment (yet). Not a failure.
    if (!response.ok || data.status === undefined || data.status === null) {
      return this.stillPending(payment, step, { http_status: response.status, ...data });
    }

    if ((scalar(data.orderId) ?? '') !== payment.gatewayReference) {
      throw new InvalidCallbackError('Nagad verify returned a different orderId.', this.name, data);
    }

    if (
      data.merchantId !== undefined &&
      data.merchantId !== null &&
      scalar(data.merchantId) !== this.credential('merchantId')
    ) {
      throw new InvalidCallbackError('Nagad verify returned a different merchantId.', this.name, data);
    }

    const rawStatus = scalar(data.status) ?? '';
    const status = rawStatus.toLowerCase();
    const attributes: Partial<Payment> = { gatewayPaymentId: refId };

    if (status === PAID) {
      this.assertAmountMatches(payment, scalar(data.amount));

      return this.transition(
        payment,
        PaymentStatus.Completed,
        { ...attributes, gatewayTransactionId: scalar(data.issuerPaymentRefNo) },
        step,
        data,
      );
    }

    const statusCode = scalar(data.statusCode);
    const reason = limit(`Nagad: ${rawStatus}${statusCode !== null ? ` (${statusCode})` : ''}`, 255);

    if (CANCELLED.includes(status)) {
      return this.transition(
        payment,
        PaymentStatus.Cancelled,
        { ...attributes, failureReason: reason },
        step,
        data,
      );
    }

    if (FAILED.includes(status)) {
      return this.transition(
        payment,
        PaymentStatus.Failed,
        { ...attributes, failureReason: reason },
        step,
        data,
      );
    }

    // OrderInitiated, Ready, InProgress, OtpSent, OtpVerified, PinGiven,
    // PartialCancelled, or anything new: not a settled answer.
    return this.stillPending(payment, step, data);
  }

  /**
   * The RSA helper, built from config. Public so callers can reuse it (e.g. to
   * check a key pair during onboarding).
   */
  crypto(): NagadCrypto {
    this.cryptoHelper ??= new NagadCrypto(
      this.credential('publicKey'),
      this.credential('privateKey'),
      this.option('signatureAlgorithm', 'sha256'),
      this.name,
    );

    return this.cryptoHelper;
  }

  private headers(ip: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'X-KM-Api-Version': this.option('apiVersion', NagadGateway.API_VERSION),
      'X-KM-IP-V4': ip,
      'X-KM-Client-Type': this.option('clientType', 'PC_WEB'),
    };
  }

  /** Decrypt (and optionally verify) an encrypted response envelope. */
  private async open(data: JsonObject): Promise<JsonObject> {
    const plain = await this.crypto().decrypt(String(data.sensitiveData));

    if (
      this.config.verifyResponseSignature === true &&
      !(await this.crypto().verify(plain, typeof data.signature === 'string' ? data.signature : ''))
    ) {
      throw new GatewayError('Nagad response signature does not verify.', this.name);
    }

    let decoded: unknown;

    try {
      decoded = JSON.parse(plain);
    } catch {
      decoded = null;
    }

    if (Array.isArray(decoded)) {
      return { ...decoded };
    }

    if (!isObject(decoded)) {
      throw new GatewayError('Nagad response sensitiveData is not JSON.', this.name);
    }

    return decoded;
  }

  /**
   * X-KM-IP-V4 should be the customer's IPv4. Behind IPv6, a private address or no
   * request at all (a queue, a scheduler), fall back to the configured "ip".
   */
  private clientIp(candidate: string | null): string {
    if (candidate !== null && isPublicIpv4(candidate)) {
      return candidate;
    }

    const configured = this.config.ip;

    if (typeof configured === 'string' && isIpv4(configured)) {
      return configured;
    }

    return candidate !== null && isIpv4(candidate) ? candidate : '127.0.0.1';
  }
}

/** Nagad rejects timestamps outside a short window of Bangladesh time (UTC+6, no DST). */
function dhakaTime(): string {
  const dhaka = new Date(Date.now() + 6 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    String(dhaka.getUTCFullYear()) +
    pad(dhaka.getUTCMonth() + 1) +
    pad(dhaka.getUTCDate()) +
    pad(dhaka.getUTCHours()) +
    pad(dhaka.getUTCMinutes()) +
    pad(dhaka.getUTCSeconds())
  );
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

/** An IPv4 outside the private (10/8, 172.16/12, 192.168/16) and reserved (0/8, 127/8, 169.254/16, 240/4) ranges. */
function isPublicIpv4(value: string): boolean {
  if (!isIpv4(value)) {
    return false;
  }

  const [a = 0, b = 0] = value.split('.').map(Number);

  return !(
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    a >= 240
  );
}

/** A scalar as a string; null for anything else. */
function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null;
}

function errorMessage(data: JsonObject, status: number): string {
  const message = data.message ?? data.devMessage ?? `HTTP ${status}`;
  const reason = scalar(data.reason);

  return (scalar(message) ?? `HTTP ${status}`) + (reason !== null ? ` [${reason}]` : '');
}
