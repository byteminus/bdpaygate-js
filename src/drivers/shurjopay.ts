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
import { field, isObject, limit } from '../core/util.js';

export interface ShurjoPayAuth {
  token: string;
  storeId: string;
}

/**
 * ShurjoPay hosted checkout (API v2): token grant, secret-pay and verification.
 *
 * Cards (Visa, Mastercard, Amex, UnionPay, Nexus), bKash, Nagad, Rocket, Upay
 * and several smaller wallets on one checkout page. No refund API.
 *
 * Config: username, password, prefix, sandbox.
 *
 * Docs: https://shurjopay.com.bd/frontend-developers/direct-integration-with-api
 */
export class ShurjoPayGateway extends AbstractGateway {
  static override readonly driver = 'shurjopay';

  static readonly SANDBOX_URL = 'https://sandbox.shurjopayment.com';
  static readonly LIVE_URL = 'https://engine.shurjopayment.com';

  /** Verification sp_code values. 1068 and 1064 are undocumented but returned by the API. */
  static readonly PAID = '1000';
  static readonly DECLINED = '1001';
  static readonly CANCELLED = '1002';
  static readonly INITIATED = '1068';
  static readonly UNAUTHORIZED = '1064';

  /** The docs and the sandbox agree on 15 minutes; expires_in is not trusted beyond that. */
  private static readonly TOKEN_TTL = 900;

  override readonly capabilities: Capabilities = { sync: true, refunds: false };

  get baseUrl(): string {
    return this.endpoint(ShurjoPayGateway.SANDBOX_URL, ShurjoPayGateway.LIVE_URL);
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    if (this.currency !== 'BDT' && this.currency !== 'USD') {
      throw new GatewayError('ShurjoPay accepts BDT or USD only.', this.name);
    }

    const prefix = this.credential('prefix');
    const payment = await this.createPendingPayment(options);
    const customer = options.customer;
    const city = customer.city ?? 'Dhaka';
    const meta = options.meta ?? {};

    const data = await this.authorised((auth) =>
      this.http(`${this.baseUrl}/api/secret-pay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.token}` },
        json: filled({
          prefix,
          token: auth.token,
          store_id: auth.storeId,
          return_url: this.callbackUrl('success'),
          cancel_url: this.callbackUrl('cancel'),
          amount: payment.amount,
          order_id: payment.gatewayReference,
          currency: payment.currency,
          customer_name: customer.name,
          customer_address: customer.address ?? city,
          customer_email: customer.email ?? 'noemail@example.com',
          customer_phone: customer.phone,
          customer_city: city,
          customer_country: customer.country ?? 'Bangladesh',
          // Required by ShurjoPay: the sandbox rejects a payment without it.
          client_ip: customer.ip || field(meta, 'client_ip') || '127.0.0.1',
          value1: payment.reference,
          value2: payment.id,
        }),
      }),
    );

    const checkoutUrl = field(data, 'checkout_url');
    const spOrderId = field(data, 'sp_order_id');

    if (checkoutUrl === null || spOrderId === null) {
      await this.save(this.log(payment, 'create', data));

      throw new GatewayError(`ShurjoPay could not create the payment: ${message(data)}`, this.name, data);
    }

    const echoed = data.customer_order_id;

    if (echoed !== undefined && echoed !== null && String(echoed) !== payment.gatewayReference) {
      await this.save(this.log(payment, 'create', data));

      throw new GatewayError('ShurjoPay echoed a different order_id.', this.name, data);
    }

    payment.gatewayPaymentId = spOrderId;
    payment.checkoutUrl = checkoutUrl;

    return this.save(this.log(payment, 'create', data));
  }

  /**
   * ShurjoPay returns the customer (return_url / cancel_url) and pings the IPN
   * with only ?order_id=<sp_order_id>: no status, no signature. Everything is
   * decided by the verification API.
   */
  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const orderId = request.string('order_id');

    if (orderId === '') {
      throw new InvalidCallbackError('ShurjoPay callback has no order_id.', this.name, request.all());
    }

    const payment = await this.findByGatewayPaymentId(orderId);

    if (this.isPaid(payment)) {
      return this.unchanged(payment);
    }

    return this.settle(payment, outcome);
  }

  override async sync(payment: Payment): Promise<Payment> {
    if (payment.gatewayPaymentId && !this.isPaid(payment)) {
      await this.settle(payment, 'sync');
    }

    return this.reload(payment);
  }

  /**
   * Apply what the verification API says. Only a confirmed decline or
   * cancellation fails the payment; anything else leaves it pending.
   */
  private async settle(payment: Payment, step: string): Promise<CallbackResult> {
    const data = await this.verify(payment);
    const code = field(data, 'sp_code') ?? '';

    switch (code) {
      case ShurjoPayGateway.PAID:
        return this.complete(payment, data, step);
      case ShurjoPayGateway.DECLINED:
        return this.transition(
          payment,
          PaymentStatus.Failed,
          { failureReason: limit(message(data), 255) },
          step,
          data,
        );
      case ShurjoPayGateway.CANCELLED:
        return this.transition(
          payment,
          PaymentStatus.Cancelled,
          { failureReason: limit(message(data), 255) },
          step,
          data,
        );
      default:
        return this.stillPending(payment, step, data);
    }
  }

  private async complete(payment: Payment, data: JsonObject, step: string): Promise<CallbackResult> {
    const currency = data.currency;

    this.assertAmountMatches(
      payment,
      data.amount,
      currency !== undefined && currency !== null ? String(currency) : null,
    );

    return this.transition(
      payment,
      PaymentStatus.Completed,
      { gatewayTransactionId: field(data, 'bank_trx_id') },
      step,
      data,
    );
  }

  /** Server-to-server verification by sp_order_id (it cannot look up your order_id). */
  async verify(payment: Payment): Promise<JsonObject> {
    const orderId = payment.gatewayPaymentId;

    if (!orderId) {
      throw new GatewayError('ShurjoPay payment has no sp_order_id to verify.', this.name);
    }

    const data = await this.authorised((auth) =>
      this.http(`${this.baseUrl}/api/verification`, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.token}` },
        json: { order_id: orderId },
      }),
    );

    // Unpaid and unknown orders also carry an order_id; cross-check whatever came back.
    if (isSet(data.order_id) && String(data.order_id) !== orderId) {
      throw new InvalidCallbackError(
        'ShurjoPay verification returned a different order_id.',
        this.name,
        data,
      );
    }

    if (isSet(data.customer_order_id) && String(data.customer_order_id) !== payment.gatewayReference) {
      throw new InvalidCallbackError(
        'ShurjoPay verification returned a different customer_order_id.',
        this.name,
        data,
      );
    }

    return data;
  }

  /**
   * Run a call with a cached token. On "1064 Unauthorized" (expired or revoked
   * token) fetch a new token and try once more.
   */
  private async authorised(call: (auth: ShurjoPayAuth) => Promise<HttpResponse>): Promise<JsonObject> {
    for (let attempt = 1; ; attempt++) {
      const data = normalise((await call(await this.auth())).data);

      if ((field(data, 'sp_code') ?? '') !== ShurjoPayGateway.UNAUTHORIZED) {
        return data;
      }

      await this.forgetToken('auth');

      if (attempt >= 2) {
        // The payment may well be paid; we just cannot ask. Leave it pending.
        throw new GatewayUnavailableError(
          'ShurjoPay rejected the token twice (1064 Unauthorized). Check the username and password.',
          this.name,
          data,
        );
      }
    }
  }

  /** Token and store_id from /api/get_token, cached together. */
  async auth(): Promise<ShurjoPayAuth> {
    const cached = await this.rememberToken('auth', async () => {
      const response = await this.http(`${this.baseUrl}/api/get_token`, {
        method: 'POST',
        json: { username: this.credential('username'), password: this.credential('password') },
      });
      const data = normalise(response.data);
      const token = field(data, 'token');

      if ((field(data, 'sp_code') ?? '') !== '200' || token === null || !isSet(data.store_id)) {
        throw new GatewayError(`ShurjoPay token request failed: ${message(data)}`, this.name, data);
      }

      const ttl =
        Math.min(
          ShurjoPayGateway.TOKEN_TTL,
          Math.trunc(Number(data.expires_in ?? ShurjoPayGateway.TOKEN_TTL)) || ShurjoPayGateway.TOKEN_TTL,
        ) - 60;

      return [JSON.stringify({ token, store_id: String(data.store_id) }), ttl];
    });

    let auth: unknown = null;

    try {
      auth = JSON.parse(cached);
    } catch {
      // Unreadable: handled below.
    }

    if (!isObject(auth) || typeof auth.token !== 'string' || typeof auth.store_id !== 'string') {
      await this.forgetToken('auth');

      throw new GatewayError('Cached ShurjoPay token is unreadable.', this.name);
    }

    return { token: auth.token, storeId: auth.store_id };
  }
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Drop null and empty values: ShurjoPay validates every field it is sent. */
function filled(values: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== '') {
      out[key] = value;
    }
  }

  return out;
}

/** Verification answers with a one-element array; some errors are a bare object. */
function normalise(data: JsonObject): JsonObject {
  const keys = Object.keys(data);
  const first = data['0'];

  if (keys.length > 0 && keys.every((key, index) => key === String(index)) && isObject(first)) {
    return first;
  }

  return data;
}

function message(data: JsonObject): string {
  for (const key of ['sp_message', 'sp_massage', 'message', 'body']) {
    const value = field(data, key);

    if (value !== null) {
      const code = field(data, 'sp_code');

      return `${code !== null ? `${code} ` : ''}${value}`;
    }
  }

  // Validation errors come back as {"field": "The field is required."}.
  const errors = Object.values(data).filter((value): value is string => typeof value === 'string');

  return errors.length > 0 ? errors.join(' ') : 'unexpected response';
}
