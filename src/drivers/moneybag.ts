import { GatewayError, InvalidCallbackError } from '../core/errors.js';
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
import { isObject, limit, object, str } from '../core/util.js';

/**
 * Moneybag hosted checkout (public API v2): checkout, then verify.
 *
 * The public contract has no lookup by order or session and no refund API,
 * so this driver has no sync() or refund(). A payment is settled from the
 * transaction_id Moneybag appends to the return URL, or later with
 * verifyTransaction() and an id from the merchant portal.
 *
 * Config: apiKey, sandbox.
 *
 * Docs: https://developers.moneybag.com.bd/docs
 */
export class MoneybagGateway extends AbstractGateway {
  static override readonly driver = 'moneybag';

  static readonly SANDBOX_URL = 'https://sandbox.api.moneybag.com.bd';
  static readonly LIVE_URL = 'https://api.moneybag.com.bd';

  override readonly capabilities: Capabilities = { sync: false, refunds: false };

  get baseUrl(): string {
    return this.endpoint(MoneybagGateway.SANDBOX_URL, MoneybagGateway.LIVE_URL);
  }

  private headers(): Record<string, string> {
    return { 'X-Merchant-API-Key': this.credential('apiKey') };
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    const requested = Number(String(options.amount).trim()) || 0;

    if (this.currency === 'BDT' && (requested < 10 || requested > 1_000_000)) {
      throw new GatewayError('Moneybag accepts 10.00 to 1000000.00 BDT.', this.name);
    }

    const payment = await this.createPendingPayment(options);
    const customer = options.customer;
    const ref = { ref: payment.gatewayReference };
    const address = customer.address ?? null;
    const postcode = scalar(customer.postcode ?? options.meta?.postcode ?? null);

    const details: Record<string, string | null> = {
      name: limit(customer.name, 255),
      email: customer.email ?? 'noemail@example.com',
      phone: customer.phone,
      address: address !== null ? limit(address, 200) : null,
      city: limit(customer.city ?? 'Dhaka', 50),
      country: limit(customer.country ?? 'Bangladesh', 50),
      postcode: postcode !== null ? limit(postcode, 20) : null,
    };

    const response = await this.http(`${this.baseUrl}/api/v2/payments/checkout`, {
      method: 'POST',
      headers: this.headers(),
      json: {
        order_id: payment.gatewayReference,
        order_amount: payment.amount,
        currency: payment.currency,
        order_description: limit(options.description ?? `Order ${payment.reference}`, 255),
        success_url: this.callbackUrl('success', ref),
        fail_url: this.callbackUrl('fail', ref),
        cancel_url: this.callbackUrl('cancel', ref),
        customer: Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null)),
        metadata: { reference: payment.reference },
      },
    });
    const data = response.data;
    const session = object(data, 'data');
    const url = session.checkout_url;

    if (!response.ok || data.success !== true || typeof url !== 'string' || url === '') {
      await this.save(this.log(payment, 'create', data));

      throw new GatewayError(
        `Moneybag could not create the checkout: ${errorMessage(data, response)}`,
        this.name,
        data,
      );
    }

    payment.gatewayPaymentId = scalar(session.session_id);
    payment.checkoutUrl = url;

    return this.save(this.log(payment, 'create', data));
  }

  /**
   * Moneybag returns the customer with ?transaction_id=...&status=... added
   * to our URL. Neither is trusted: the transaction is verified, and must
   * belong to this order.
   */
  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const payment = await this.findByGatewayReference(request.queryString('ref'));
    const transactionId = request.queryString('transaction_id');

    // A checkout abandoned before a transaction existed: nothing to verify.
    if (transactionId === '') {
      return this.stillPending(payment, outcome, request.query);
    }

    return this.confirm(payment, transactionId, outcome);
  }

  /**
   * Settle a payment from a Moneybag transaction id, e.g. one found in the
   * merchant portal after the customer never came back.
   */
  async verifyTransaction(payment: Payment, transactionId: string): Promise<Payment> {
    await this.confirm(payment, transactionId, 'verify');

    return this.reload(payment);
  }

  private async confirm(payment: Payment, transactionId: string, step: string): Promise<CallbackResult> {
    const response = await this.http(
      `${this.baseUrl}/api/v2/payments/verify/${rawUrlEncode(transactionId)}`,
      { method: 'GET', headers: this.headers() },
    );
    const data = response.data;
    const found = data.data;

    // Unknown or expired transaction, validation error, or no clear answer.
    if (!response.ok || data.success !== true || found === null || typeof found !== 'object') {
      return this.stillPending(payment, step, data);
    }

    const transaction: JsonObject = isObject(found) ? found : {};

    if (str(transaction.order_id) !== payment.gatewayReference) {
      throw new InvalidCallbackError('Moneybag transaction belongs to a different order.', this.name, data);
    }

    const status = str(transaction.status).toUpperCase();
    const attributes: Partial<Payment> = {
      gatewayTransactionId: isSet(transaction.transaction_id)
        ? str(transaction.transaction_id)
        : transactionId,
    };

    if (status === 'SUCCESS' && transaction.verified === true) {
      // `amount` is the order amount; Moneybag reports its service charge separately (charge_amount).
      this.assertAmountMatches(
        payment,
        transaction.amount ?? null,
        isSet(transaction.currency) ? str(transaction.currency) : null,
      );

      return this.transition(payment, PaymentStatus.Completed, attributes, step, data);
    }

    switch (status) {
      case 'FAILED':
        return this.transition(
          payment,
          PaymentStatus.Failed,
          { ...attributes, failureReason: 'Payment failed' },
          step,
          data,
        );
      case 'CANCELLED':
        return this.transition(payment, PaymentStatus.Cancelled, attributes, step, data);
      default:
        return this.stillPending(payment, step, data);
    }
  }
}

function errorMessage(data: JsonObject, response: HttpResponse): string {
  if (typeof data.message === 'string' && data.message !== '') {
    return data.message;
  }

  // 422: {"detail": [{"loc": [...], "msg": "...", "type": "..."}]}
  const detail = data.detail;

  if (detail !== null && typeof detail === 'object') {
    const messages: string[] = [];

    for (const item of Object.values(detail)) {
      if (isObject(item) && isSet(item.msg)) {
        const location = Array.isArray(item.loc) ? item.loc.map((part) => str(part)).join('.') : '';
        messages.push(`${location} ${str(item.msg)}`.trim());
      }
    }

    if (messages.length > 0) {
      return messages.join('; ');
    }
  }

  return `HTTP ${response.status}`;
}

/** Percent-encode everything but A-Z a-z 0-9 - _ . ~ (RFC 3986), like PHP's rawurlencode. */
function rawUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** A scalar as a string, or null when missing or not a scalar. */
function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? str(value)
    : null;
}
