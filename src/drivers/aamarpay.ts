import { GatewayError, GatewayUnavailableError, InvalidCallbackError } from '../core/errors.js';
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
import { field, isObject, limit, list } from '../core/util.js';

/**
 * aamarPay hosted checkout (JSON init) with the Search Transaction API.
 *
 * Cards (Visa, Mastercard, UnionPay), bKash, Nagad, Rocket, Upay, Tap,
 * OK Wallet, SureCash and net banking on one checkout page. No refund API.
 *
 * Config: storeId, signatureKey, sandbox.
 *
 * Docs: https://aamarpay.readme.io/reference/initiate-payment-json
 */
export class AamarPayGateway extends AbstractGateway {
  static override readonly driver = 'aamarpay';

  static readonly SANDBOX_URL = 'https://sandbox.aamarpay.com';
  static readonly LIVE_URL = 'https://secure.aamarpay.com';

  /** status_code values from the docs. */
  static readonly INITIATED = '0';
  static readonly SUCCESSFUL = '2';
  static readonly EXPIRED = '3';
  static readonly FAILED = '7';

  override readonly capabilities: Capabilities = { sync: true, refunds: false };

  get baseUrl(): string {
    return this.endpoint(AamarPayGateway.SANDBOX_URL, AamarPayGateway.LIVE_URL);
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    if (this.currency !== 'BDT' && this.currency !== 'USD') {
      throw new GatewayError('aamarPay accepts BDT or USD only.', this.name);
    }

    const payment = await this.createPendingPayment(options);
    const customer = options.customer;

    // tran_id is a fresh attempt id: aamarPay accepts a reused tran_id and then
    // only reports the newest session for it.
    const response = await this.http(`${this.baseUrl}/jsonpost.php`, {
      method: 'POST',
      json: filled({
        store_id: this.credential('storeId'),
        signature_key: this.credential('signatureKey'),
        tran_id: payment.gatewayReference,
        amount: payment.amount,
        currency: payment.currency,
        desc: options.description ?? payment.reference,
        cus_name: customer.name,
        cus_email: customer.email ?? 'noemail@example.com',
        cus_phone: customer.phone,
        cus_add1: customer.address ?? null,
        cus_city: customer.city ?? 'Dhaka',
        cus_country: customer.country ?? 'Bangladesh',
        success_url: this.callbackUrl('success'),
        fail_url: this.callbackUrl('fail'),
        // The cancel return carries no documented payload, so it names the attempt itself.
        cancel_url: this.callbackUrl('cancel', { tran_id: payment.gatewayReference }),
        opt_a: payment.reference,
        opt_b: payment.id,
        type: 'json',
      }),
    });

    const data = response.data;
    const url = typeof data.payment_url === 'string' ? data.payment_url : '';

    // Success is result "true" (a string); errors are result false with
    // "errors" or "message", or plain text, all with HTTP 200.
    if ((data.result !== true && data.result !== 'true') || !url.startsWith('https://')) {
      await this.save(this.log(payment, 'create', data));

      throw new GatewayError(`aamarPay could not create the payment: ${message(data)}`, this.name, data);
    }

    // The checkout "track" is the session's pg_txnid.
    let track: string | null = null;

    try {
      track = new URL(url).searchParams.get('track');
    } catch {
      // Not parseable: no track.
    }

    payment.gatewayPaymentId = track !== null && track !== '' ? track : null;
    payment.checkoutUrl = url;

    return this.save(this.log(payment, 'create', data));
  }

  /**
   * The browser POSTs to success_url / fail_url, the IPN posts JSON, cancel
   * is a plain return. All are claims: Search Transaction decides.
   */
  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const tranId = value(request.all().mer_txnid) ?? value(request.query.tran_id) ?? '';
    const payment = await this.findByGatewayReference(tranId);

    const claimed = value(request.all().pg_txnid);

    if (claimed !== null && payment.gatewayPaymentId && claimed !== payment.gatewayPaymentId) {
      throw new InvalidCallbackError(
        'aamarPay callback pg_txnid does not belong to this attempt.',
        this.name,
        request.all(),
      );
    }

    if (this.isPaid(payment)) {
      return this.unchanged(payment);
    }

    return this.settle(payment, outcome);
  }

  override async sync(payment: Payment): Promise<Payment> {
    if (!this.isPaid(payment)) {
      await this.settle(payment, 'sync');
    }

    return this.reload(payment);
  }

  /**
   * Apply what Search Transaction says. Only a confirmed failure or expiry
   * fails the payment; anything else leaves it pending.
   */
  private async settle(payment: Payment, step: string): Promise<CallbackResult> {
    const data = await this.search(payment);
    const code = field(data, 'status_code') ?? '';
    const pgTxnId = value(data.pg_txnid);
    const reason = value(data.status_title) ?? value(data.pay_status);

    switch (code) {
      case AamarPayGateway.SUCCESSFUL:
        return this.complete(payment, data, step);
      case AamarPayGateway.FAILED:
      case AamarPayGateway.EXPIRED:
        return this.transition(
          payment,
          PaymentStatus.Failed,
          {
            gatewayPaymentId: payment.gatewayPaymentId ?? pgTxnId,
            failureReason: reason !== null ? limit(reason, 255) : null,
          },
          step,
          data,
        );
      default:
        return this.stillPending(payment, step, data);
    }
  }

  private async complete(payment: Payment, data: JsonObject, step: string): Promise<CallbackResult> {
    const payStatus = value(data.pay_status);

    if (payStatus !== null && payStatus.toLowerCase() !== 'successful') {
      // status_code and pay_status disagree: do not decide either way.
      return this.stillPending(payment, step, data);
    }

    // "amount" is in BDT; for a USD payment the original amount is amount_currency.
    this.assertAmountMatches(
      payment,
      payment.currency === 'BDT' ? data.amount : data.amount_currency,
      value(data.currency_merchant) ?? value(data.currency),
    );

    const risk = value(data.risk_level);

    return this.transition(
      payment,
      PaymentStatus.Completed,
      {
        gatewayPaymentId: payment.gatewayPaymentId ?? value(data.pg_txnid),
        gatewayTransactionId: value(data.bank_trxid),
        requiresReview: risk !== null && NUMERIC.test(risk) && Math.trunc(Number(risk)) > 0,
      },
      step,
      data,
    );
  }

  /** Search Transaction by tran_id (aamarPay cannot look up by pg_txnid). */
  async search(payment: Payment): Promise<JsonObject> {
    const { data } = await this.http(`${this.baseUrl}/api/v1/trxcheck/request.php`, {
      method: 'GET',
      query: {
        request_id: payment.gatewayReference,
        store_id: this.credential('storeId'),
        signature_key: this.credential('signatureKey'),
        type: 'json',
      },
    });

    if (isSet(data.body) && !isSet(data.status_code)) {
      // Plain text such as "Store_id & signature key not matched". The
      // payment may be paid; we cannot tell. Leave it pending.
      throw new GatewayUnavailableError(`aamarPay search failed: ${message(data)}`, this.name, data);
    }

    const merTxnId = value(data.mer_txnid);

    if (merTxnId !== null && merTxnId !== payment.gatewayReference) {
      throw new InvalidCallbackError('aamarPay search returned a different mer_txnid.', this.name, data);
    }

    // A reused tran_id would make search report the newest session only.
    // Attempt ids are never reused, so a different pg_txnid means the answer
    // is not about the session this payment opened.
    const pgTxnId = value(data.pg_txnid);

    if (pgTxnId !== null && payment.gatewayPaymentId && pgTxnId !== payment.gatewayPaymentId) {
      throw new InvalidCallbackError('aamarPay search returned a different pg_txnid.', this.name, data);
    }

    return data;
  }
}

/** A plain decimal or exponent number, as PHP's is_numeric() accepts it. */
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function isSet(input: unknown): boolean {
  return input !== undefined && input !== null;
}

function scalar(input: unknown): string | null {
  return typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean'
    ? String(input)
    : null;
}

/** A field's value, with aamarPay's "Not-Available" placeholders as null. */
function value(input: unknown): string | null {
  const text = scalar(input)?.trim() ?? '';

  return text === '' || ['not-available', 'not available'].includes(text.toLowerCase()) ? null : text;
}

/** Drop null and empty values before sending. */
function filled(values: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, input] of Object.entries(values)) {
    if (input !== null && input !== '') {
      out[key] = input;
    }
  }

  return out;
}

function message(data: JsonObject): string {
  if (Array.isArray(data.errors) || isObject(data.errors)) {
    return list(data, 'errors')
      .map(scalar)
      .filter((error): error is string => error !== null)
      .join(' ');
  }

  for (const key of ['message', 'status', 'body']) {
    const text = scalar(data[key]);

    if (text !== null && text !== '') {
      return text;
    }
  }

  return 'unexpected response';
}
