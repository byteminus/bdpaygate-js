import { GatewayError, InvalidCallbackError } from '../core/errors.js';
import { AbstractGateway } from '../core/gateway.js';
import { parseParams } from '../core/handler.js';
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
  type RefundResult,
} from '../core/types.js';
import { field, isObject, list, object } from '../core/util.js';

const CANCELLED = ['cancelled', 'canceled'];

const FAILED = ['failed', 'expired'];

/**
 * Upay (UCB Fintech) merchant payment gateway.
 *
 * BETA: built from public information and not yet verified against a merchant
 * sandbox. Upay hands out its API document at onboarding; check this driver
 * against it.
 *
 * Flow: merchant-auth (JWT) -> merchant-payment-init -> redirect to
 * gateway_url -> unsigned browser redirect with status and invoice_id ->
 * single-payment-status. Refunds go through the bulk refund endpoint, full
 * amount only, and may be answered "under process".
 *
 * Config: merchantId, merchantKey, merchantName, merchantCode,
 * merchantCategoryCode, merchantMobile, merchantCity (default Dhaka),
 * merchantCountryCode (default BD), tokenTtl (seconds, default 600), sandbox.
 * Upay whitelists server IPs: pass a `fetch` with a proxy dispatcher when your
 * server's IP is not the one registered.
 */
export class UpayGateway extends AbstractGateway {
  static override readonly driver = 'upay';

  static readonly SANDBOX_URL = 'https://uat-pg.upay.systems';
  static readonly LIVE_URL = 'https://pg.upaysystem.com';

  override readonly capabilities: Capabilities = { sync: true, refunds: 'full' };

  get baseUrl(): string {
    return this.endpoint(UpayGateway.SANDBOX_URL, UpayGateway.LIVE_URL);
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    if (this.currency !== 'BDT') {
      throw new GatewayError('Upay only accepts BDT.', this.name);
    }

    const merchant = {
      merchant_id: this.credential('merchantId'),
      merchant_name: this.credential('merchantName'),
      merchant_code: this.credential('merchantCode'),
      merchant_country_code: this.option('merchantCountryCode', 'BD'),
      merchant_city: this.option('merchantCity', 'Dhaka'),
      merchant_category_code: this.credential('merchantCategoryCode'),
      merchant_mobile: this.credential('merchantMobile'),
    };

    const payment = await this.createPendingPayment(options);
    const additional: JsonObject = { reference: payment.reference };

    if (options.description !== undefined && options.description !== null) {
      additional.description = options.description;
    }

    // Upay sends the customer back with only invoice_id, and looks payments
    // up by txn_id: use the per-attempt id for both. The "txn" query param
    // gives Upay's appended "&status=..&invoice_id=.." a query to join.
    const response = await this.call('POST', '/payment/merchant-payment-init/', {
      date: dhakaDate(),
      txn_id: payment.gatewayReference,
      invoice_id: payment.gatewayReference,
      amount: payment.amount,
      transaction_currency_code: 'BDT',
      redirect_url: this.callbackUrl('callback', { txn: payment.gatewayReference }),
      additional_info: additional,
      ...merchant,
    });

    const data = response.data;
    const body = object(data, 'data');
    const gatewayUrl = body.gateway_url;

    if (!response.ok || typeof gatewayUrl !== 'string' || gatewayUrl === '') {
      await this.save(this.log(payment, 'create', data));

      throw new GatewayError(
        `Upay could not create the payment: ${errorMessage(data, response.status)}`,
        this.name,
        data,
      );
    }

    payment.gatewayPaymentId = scalar(body.trx_id);
    payment.checkoutUrl = gatewayUrl;

    return this.save(this.log(payment, 'create', data));
  }

  /**
   * The redirect carries "status" and "invoice_id", nothing signed. It only
   * says which payment to look at; single-payment-status decides.
   */
  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const params = callbackParams(request);
    const invoiceId =
      typeof params.invoice_id === 'string' && params.invoice_id !== ''
        ? params.invoice_id
        : typeof params.txn === 'string'
          ? params.txn
          : '';

    const payment = await this.findByGatewayReference(invoiceId);

    if (this.isPaid(payment)) {
      return this.unchanged(payment);
    }

    return this.query(payment, outcome);
  }

  override async sync(payment: Payment): Promise<Payment> {
    await this.query(payment, 'sync');

    return this.reload(payment);
  }

  /**
   * Ask Upay for the payment's status and apply it. Anything that is not a
   * clear answer leaves the payment pending.
   */
  private async query(payment: Payment, step: string): Promise<CallbackResult> {
    const response = await this.call(
      'GET',
      `/payment/single-payment-status/${encodeURIComponent(payment.gatewayReference)}/`,
    );
    const data = response.data;
    const body = object(data, 'data');

    // Not found (PNF4012), an error envelope, or no status: not an answer.
    if (!response.ok || body.status === undefined || body.status === null) {
      return this.stillPending(payment, step, { http_status: response.status, ...data });
    }

    if ((scalar(body.txn_id) ?? '') !== payment.gatewayReference) {
      throw new InvalidCallbackError('Upay status returned a different txn_id.', this.name, data);
    }

    const status = (scalar(body.status) ?? '').toLowerCase();
    const trxId = scalar(body.trx_id);
    const attributes: Partial<Payment> = trxId !== null ? { gatewayPaymentId: trxId } : {};

    if (status === 'success') {
      this.assertAmountMatches(payment, scalar(body.amount));

      return this.transition(
        payment,
        PaymentStatus.Completed,
        { ...attributes, gatewayTransactionId: trxId },
        step,
        data,
      );
    }

    const reason = `Upay: ${status}`;

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

    return this.stillPending(payment, step, data);
  }

  /**
   * Upay's bulk refund endpoint with a single entry. A refund can be answered
   * "under process": it was taken and will settle later, so it counts as
   * accepted and pending. Upay documents no refund status endpoint.
   */
  protected override async requestRefund(
    payment: Payment,
    amount: string,
    _reason: string | null,
  ): Promise<RefundResult> {
    const txnId = payment.gatewayReference;
    const response = await this.call('POST', '/payment/bulk/refund/', [
      { txn_id: txnId, refund_amount: amount },
    ]);
    const data = response.data;
    const body = object(data, 'data');

    for (const item of list(body, 'success_list')) {
      if (entryTxnId(item) === txnId) {
        return this.refundResult(payment, {
          accepted: true,
          amount,
          message: errorMessage(data, response.status),
          raw: data,
        });
      }
    }

    const message = failureFor(body.failed_list, txnId) ?? errorMessage(data, response.status);
    const underProcess = message.toLowerCase().includes('under process');

    return this.refundResult(payment, {
      accepted: underProcess,
      amount,
      message,
      raw: data,
      pending: underProcess,
    });
  }

  /** Send an authorised JSON request, re-authenticating once if the token was refused. */
  private async call(method: 'GET' | 'POST', path: string, json?: unknown): Promise<HttpResponse> {
    const attempt = async (): Promise<HttpResponse> =>
      this.http(this.baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', authorization: `UPAY ${await this.token()}` },
        ...(json === undefined ? {} : { json }),
      });

    let response = await attempt();

    if (response.status === 401 || response.status === 403) {
      await this.forgetToken(this.tokenKey());
      response = await attempt();
    }

    return response;
  }

  /**
   * The merchant-auth JWT. Upay documents no expiry, so it is cached for
   * `tokenTtl` seconds (default 10 minutes) and refreshed on a 401/403.
   */
  private token(): Promise<string> {
    return this.rememberToken(this.tokenKey(), async () => {
      const response = await this.http(`${this.baseUrl}/payment/merchant-auth/`, {
        method: 'POST',
        json: {
          merchant_id: this.credential('merchantId'),
          merchant_key: this.credential('merchantKey'),
        },
      });
      const data = response.data;
      const token = object(data, 'data').token;

      if (!response.ok || typeof token !== 'string' || token === '') {
        // Never log the response: a token carries the merchant key.
        throw new GatewayError(
          `Upay merchant authorization failed: ${errorMessage(data, response.status)}`,
          this.name,
        );
      }

      return [token, Math.trunc(Number(this.option('tokenTtl', '600'))) || 600];
    });
  }

  private tokenKey(): string {
    return `upay:${this.credential('merchantId')}`;
  }
}

/**
 * The redirect's query, read leniently. Upay appends "&status=..&invoice_id=.."
 * to redirect_url; if it appends "?..." to a URL that already has a query,
 * the parser folds everything after the second "?" into the first value, so
 * split on both.
 */
function callbackParams(request: CallbackRequest): JsonObject {
  const query: JsonObject = {};

  for (const [key, value] of Object.entries(request.query)) {
    if (typeof value === 'string' && value.includes('?')) {
      const [head = '', ...rest] = value.split('?');
      query[key] = head;
      Object.assign(query, parseParams(new URLSearchParams(rest.join('&'))));
    } else {
      query[key] = value;
    }
  }

  return { ...request.all(), ...query };
}

/** Today's date in Bangladesh (UTC+6, no DST), as Y-m-d. */
function dhakaDate(): string {
  return new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
}

function entryTxnId(item: unknown): string | null {
  return scalar(isObject(item) ? item.txn_id : item);
}

/**
 * failed_list is keyed by txn_id with bilingual {en, bn} messages; accept
 * a list of entries carrying txn_id too.
 */
function failureFor(failed: unknown, txnId: string): string | null {
  if (!isObject(failed) && !Array.isArray(failed)) {
    return null;
  }

  const entries: unknown[] = Array.isArray(failed) ? failed : Object.values(failed);
  let entry: unknown = isObject(failed) ? failed[txnId] : undefined;

  if (entry === undefined || entry === null) {
    entry = entries.find((item) => entryTxnId(item) === txnId);
  }

  if (isObject(entry)) {
    entry = entry.en ?? entry.message ?? entry.reason ?? null;

    if (isObject(entry)) {
      entry = entry.en ?? null;
    }
  }

  return scalar(entry);
}

/** A scalar as a string; null for anything else. */
function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null;
}

function errorMessage(data: JsonObject, status: number): string {
  const raw = data.message;
  const message = isObject(raw) ? raw.en : raw;
  const code = field(data, 'code');
  const text = scalar(message);

  return (text !== null && text !== '' ? text : `HTTP ${status}`) + (code !== null ? ` [${code}]` : '');
}
