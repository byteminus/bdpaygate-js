import { GatewayError, InvalidCallbackError, MalformedCallbackError } from '../core/errors.js';
import { AbstractGateway } from '../core/gateway.js';
import type { HttpRequest, HttpResponse } from '../core/http.js';
import type { CallbackRequest } from '../core/request.js';
import {
  type CallbackResult,
  type Capabilities,
  type ChargeOptions,
  type JsonObject,
  type Outcome,
  type Payment,
  PaymentStatus,
  type RefundResult,
} from '../core/types.js';
import { field, isObject, limit, nodeCrypto, object } from '../core/util.js';

/**
 * Invoice states that mean the customer paid. The refund states only
 * follow an accepted payment, so they prove the money moved too.
 */
const PAID = ['ACCEPTED', 'REFUND_PENDING', 'REFUND_PROCESSING'];

/**
 * PortPos (formerly PortWallet) hosted invoice checkout, API v2: cards,
 * mobile wallets, net banking and EMI.
 *
 * The browser return and the IPN are unsigned, so every one is confirmed with
 * the IPN validate API, which takes the invoice id and the expected amount.
 *
 * Config: appKey, secretKey, validity (seconds an invoice stays payable),
 * zipcode (default billing zipcode, "1000"), sandbox.
 *
 * Docs: https://developer.portpos.com/documentation-v2.php
 */
export class PortPosGateway extends AbstractGateway {
  static override readonly driver = 'portpos';

  static readonly SANDBOX_URL = 'https://api-sandbox.portpos.com';
  static readonly LIVE_URL = 'https://api.portpos.com';
  static readonly SANDBOX_PAYMENT_URL = 'https://ppv2.portpos.com';
  static readonly LIVE_PAYMENT_URL = 'https://payment.portpos.com';

  override readonly capabilities: Capabilities = { sync: true, refunds: 'partial' };

  get baseUrl(): string {
    return this.endpoint(PortPosGateway.SANDBOX_URL, PortPosGateway.LIVE_URL);
  }

  /**
   * Every call carries a fresh token: base64("appKey:" + md5(secretKey + unix time)).
   * Keep the server clock NTP-synced; a skewed clock is rejected with 401.
   */
  private async request(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
    const { createHash } = await nodeCrypto();
    const now = Math.floor(Date.now() / 1000);
    const hash = createHash('md5')
      .update(`${this.credential('secretKey')}${now}`)
      .digest('hex');
    const token = base64(`${this.credential('appKey')}:${hash}`);

    return this.http(url, { ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } });
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    const customer = options.customer;
    const city = customer.city ?? 'Dhaka';
    const country = this.countryCode(customer.country ?? 'Bangladesh');
    const payment = await this.createPendingPayment(options);
    const meta = options.meta ?? {};
    const product = atLeastThree(options.description, `Order ${payment.reference}`);

    const order: JsonObject = {
      amount: payment.amount,
      currency: payment.currency,
      redirect_url: this.callbackUrl('callback', { ref: payment.gatewayReference }),
      ipn_url: this.callbackUrl('ipn', { ref: payment.gatewayReference }),
      reference: payment.gatewayReference,
    };

    const validity = this.config.validity;

    if (
      (typeof validity === 'number' || (typeof validity === 'string' && validity.trim() !== '')) &&
      Number.isFinite(Number(validity))
    ) {
      order.validity = Math.trunc(Number(validity));
    }

    const response = await this.request(`${this.baseUrl}/payment/v2/invoice`, {
      method: 'POST',
      json: {
        order,
        product: {
          name: limit(product, 150),
          description: limit(product, 300),
        },
        billing: {
          customer: {
            name: limit(customer.name, 50),
            email: customer.email ?? 'noemail@example.com',
            phone: customer.phone,
            address: {
              street: limit(customer.address ?? city, 200),
              city: limit(city, 200),
              state: limit(customer.state ?? scalar(meta.state) ?? city, 50),
              zipcode: customer.postcode ?? scalar(meta.zipcode) ?? scalar(this.config.zipcode) ?? '1000',
              country,
            },
          },
        },
      },
    });

    const data = response.data;
    const invoiceId = field(object(data, 'data'), 'invoice_id') ?? '';

    if (!response.ok || !succeeded(data) || invoiceId === '') {
      await this.save(this.log(payment, 'create', data));

      throw new GatewayError(
        `PortPos could not create the invoice: ${errorMessage(data, response)}`,
        this.name,
        data,
      );
    }

    const url = object(object(data, 'data'), 'action').url;

    payment.gatewayPaymentId = invoiceId;
    payment.checkoutUrl =
      typeof url === 'string' && url !== ''
        ? url
        : `${this.sandbox ? PortPosGateway.SANDBOX_PAYMENT_URL : PortPosGateway.LIVE_PAYMENT_URL}/v2/invoice/${encodeURIComponent(invoiceId)}`;

    return this.save(this.log(payment, 'create', data));
  }

  /**
   * The customer's return ("callback") and the IPN are handled alike: both
   * are claims, and only the IPN validate API decides.
   */
  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    return this.confirm(await this.findPayment(request), outcome);
  }

  /**
   * Our own ?ref= on the URLs we registered; the IPN body's reference
   * (which is ours) or invoice id as a fallback. Whichever finds the
   * payment, verification uses the invoice id and amount we stored.
   */
  private async findPayment(request: CallbackRequest): Promise<Payment> {
    const ref = queryString(request, 'ref') || request.string('reference');

    if (ref !== '') {
      return this.findByGatewayReference(ref);
    }

    return this.findByGatewayPaymentId(request.string('invoice'));
  }

  /**
   * Ask PortPos for the invoice and apply what it says. Anything other than
   * a clear answer leaves the payment as it is.
   */
  private async confirm(payment: Payment, step: string): Promise<CallbackResult> {
    const data = await this.validateInvoice(payment);
    const invoice = data.data;

    if (!isObject(invoice) || !succeeded(data)) {
      return this.stillPending(payment, step, data);
    }

    if ((scalar(invoice.invoice_id) ?? '') !== payment.gatewayPaymentId) {
      throw new InvalidCallbackError('PortPos validation returned a different invoice.', this.name, data);
    }

    const order = object(invoice, 'order');
    const status = (scalar(order.status) ?? '').toUpperCase();

    if (PAID.includes(status)) {
      this.assertAmountMatches(payment, order.amount, field(order, 'currency'));

      return this.transition(
        payment,
        PaymentStatus.Completed,
        {
          // PortPos has no transaction id; the processor's approval code is the closest thing.
          gatewayTransactionId: field(object(object(invoice, 'billing'), 'gateway'), 'approve_code'),
        },
        step,
        data,
      );
    }

    switch (status) {
      case 'CANCELLED':
        return this.transition(
          payment,
          PaymentStatus.Cancelled,
          { failureReason: 'Invoice cancelled' },
          step,
          data,
        );
      case 'EXPIRED':
        return this.transition(
          payment,
          PaymentStatus.Failed,
          { failureReason: 'Invoice expired' },
          step,
          data,
        );
      default:
        // PENDING, or a state PortPos has not documented: the customer may still pay.
        return this.stillPending(payment, step, data);
    }
  }

  /**
   * GET /payment/v2/invoice/ipn/{invoice_id}/{amount}, with the amount we
   * charged, never the one in the request.
   */
  async validateInvoice(payment: Payment): Promise<JsonObject> {
    if (!payment.gatewayPaymentId) {
      throw new InvalidCallbackError(
        `Payment [${payment.gatewayReference}] has no PortPos invoice id.`,
        this.name,
      );
    }

    const response = await this.request(
      `${this.baseUrl}/payment/v2/invoice/ipn/${encodeURIComponent(payment.gatewayPaymentId)}/${this.amount(payment.amount)}`,
      { method: 'GET' },
    );

    return response.data;
  }

  override async sync(payment: Payment): Promise<Payment> {
    if (payment.gatewayPaymentId) {
      await this.confirm(payment, 'sync');
    }

    return this.reload(payment);
  }

  /**
   * PortPos takes up to five refunds per invoice, settles them
   * asynchronously, and returns no refund id.
   */
  protected override async requestRefund(
    payment: Payment,
    amount: string,
    _reason: string | null,
  ): Promise<RefundResult> {
    if (!payment.gatewayPaymentId) {
      throw new GatewayError(`Payment [${payment.reference}] has no PortPos invoice id.`, this.name);
    }

    const response = await this.request(
      `${this.baseUrl}/payment/v2/invoice/refund/${encodeURIComponent(payment.gatewayPaymentId)}`,
      { method: 'POST', json: { refund: { amount, currency: payment.currency } } },
    );

    const data = response.data;
    const body = object(data, 'data');
    const accepted =
      response.ok &&
      succeeded(data) &&
      (field(object(body, 'refund'), 'status') ?? '').toUpperCase() === 'APPROVED';

    return this.refundResult(payment, {
      accepted,
      amount,
      refundId: null,
      message: accepted
        ? (field(object(body, 'order'), 'status') ?? 'REFUND_PENDING')
        : errorMessage(data, response),
      raw: data,
      pending: accepted,
    });
  }

  /**
   * The invoice's current state, lowercased: "refund_pending",
   * "refund_processing", "accepted", ... PortPos has no per-refund status
   * endpoint; this reads the invoice.
   */
  async refundStatus(payment: Payment): Promise<string> {
    if (!payment.gatewayPaymentId) {
      return 'unknown';
    }

    const response = await this.request(
      `${this.baseUrl}/payment/v2/invoice/${encodeURIComponent(payment.gatewayPaymentId)}`,
      { method: 'GET' },
    );

    return (field(object(object(response.data, 'data'), 'order'), 'status') ?? 'unknown').toLowerCase();
  }

  /** PortPos wants an ISO 3166 alpha-2 or alpha-3 code. */
  private countryCode(value: string): string {
    const country = value.trim();

    if (/^[A-Za-z]{2,3}$/.test(country)) {
      return country.toUpperCase();
    }

    if (country.toLowerCase() === 'bangladesh') {
      return 'BD';
    }

    throw new GatewayError(`PortPos needs an ISO 3166 country code, got [${country}].`, this.name);
  }
}

/** "result" is "success" on reads and "SUCCESS" on refunds. */
function succeeded(data: JsonObject): boolean {
  return (scalar(data.result) ?? '').toLowerCase() === 'success';
}

function errorMessage(data: JsonObject, response: HttpResponse): string {
  const error = data.error;

  if (isObject(error)) {
    const message = error.explanation ?? error.cause ?? null;

    if (typeof message === 'string' && message !== '') {
      return message + (typeof error.property === 'string' ? ` (${error.property})` : '');
    }
  }

  return `HTTP ${response.status}`;
}

/** Product name and description must be at least 3 characters. */
function atLeastThree(value: string | null | undefined, fallback: string): string {
  return value !== null && value !== undefined && [...value.trim()].length >= 3 ? value : fallback;
}

/** A query string parameter (not the body), read like CallbackRequest.string(). */
function queryString(request: CallbackRequest, key: string): string {
  const value = request.query[key];

  if (value === undefined || value === null) {
    return '';
  }

  const text = scalar(value);

  if (text === null) {
    throw new MalformedCallbackError(`Callback parameter [${key}] must be a single value.`);
  }

  return text;
}

/** A scalar as a string; null for anything else. */
function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null;
}

/** base64 of the UTF-8 bytes, without relying on Buffer. */
function base64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}
