import { GatewayError, InvalidCallbackError, MalformedCallbackError } from '../core/errors.js';
import { AbstractGateway } from '../core/gateway.js';
import { randomString } from '../core/ids.js';
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
import { field, isObject, limit, list, nodeCrypto, safeEqual } from '../core/util.js';

const PAID = ['VALID', 'VALIDATED'];

/**
 * SSLCommerz hosted checkout (v4), with the validation, transaction query and refund APIs.
 *
 * Cards, internet banking and most wallets, including Rocket (DBBL), OK Wallet
 * and IBBL/CellFin, which have no public API of their own.
 *
 * Config: storeId, storePassword, sandbox.
 *
 * Docs: https://developer.sslcommerz.com/doc/v4/
 */
export class SslCommerzGateway extends AbstractGateway {
  static override readonly driver = 'sslcommerz';

  static readonly SANDBOX_URL = 'https://sandbox.sslcommerz.com';
  static readonly LIVE_URL = 'https://securepay.sslcommerz.com';

  override readonly capabilities: Capabilities = { sync: true, refunds: 'partial' };

  get baseUrl(): string {
    return this.endpoint(SslCommerzGateway.SANDBOX_URL, SslCommerzGateway.LIVE_URL);
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    const requested = Number(options.amount);

    if (this.currency === 'BDT' && (requested < 10 || requested > 500000)) {
      throw new GatewayError('SSLCommerz accepts 10.00 to 500000.00 BDT.', this.name);
    }

    const payment = await this.createPendingPayment(options);
    const customer = options.customer;
    const city = customer.city ?? 'Dhaka';
    const meta = options.meta ?? {};

    const response = await this.http(`${this.baseUrl}/gwprocess/v4/api.php`, {
      method: 'POST',
      form: {
        store_id: this.credential('storeId'),
        store_passwd: this.credential('storePassword'),
        total_amount: payment.amount,
        currency: payment.currency,
        tran_id: payment.gatewayReference,
        success_url: this.callbackUrl('success'),
        fail_url: this.callbackUrl('fail'),
        cancel_url: this.callbackUrl('cancel'),
        ipn_url: this.callbackUrl('ipn'),
        cus_name: customer.name,
        cus_email: customer.email ?? 'noemail@example.com',
        cus_add1: customer.address ?? city,
        cus_city: city,
        cus_country: customer.country ?? 'Bangladesh',
        cus_phone: customer.phone,
        shipping_method: 'NO',
        product_name: options.description ?? payment.reference,
        product_category: scalar(meta.category) ?? 'general',
        product_profile: scalar(meta.profile) ?? 'general',
        value_a: payment.id,
        value_b: payment.reference,
      },
    });
    const data = response.data;
    const checkoutUrl = field(data, 'GatewayPageURL');

    if (!response.ok || data.status !== 'SUCCESS' || checkoutUrl === null) {
      await this.save(this.log(payment, 'create', data));

      throw new GatewayError(
        `SSLCommerz could not create the session: ${field(data, 'failedreason') ?? `HTTP ${response.status}`}`,
        this.name,
        data,
      );
    }

    payment.gatewayPaymentId = field(data, 'sessionkey');
    payment.checkoutUrl = checkoutUrl;

    return this.save(this.log(payment, 'create', data));
  }

  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const post = request.all();
    const payment = await this.findByGatewayReference(request.string('tran_id'));
    const status = request.string('status').toUpperCase();

    if ((outcome === 'success' || outcome === 'ipn') && PAID.includes(status)) {
      return this.confirmSuccess(payment, request, outcome);
    }

    // A fail or cancel is only a claim: anyone who knows the tran_id can
    // send one. Ask SSLCommerz whether the money moved before believing it.
    const confirmed = await this.query(payment);

    if (confirmed !== null) {
      return confirmed;
    }

    const cancelled = outcome === 'cancel' || status === 'CANCELLED';

    return this.transition(
      payment,
      cancelled ? PaymentStatus.Cancelled : PaymentStatus.Failed,
      { failureReason: isSet(post.error) ? limit(request.string('error'), 255) : null },
      outcome,
      post,
    );
  }

  private async confirmSuccess(
    payment: Payment,
    request: CallbackRequest,
    step: string,
  ): Promise<CallbackResult> {
    const post = request.all();

    if (isSet(post.verify_sign) && isSet(post.verify_key) && !(await this.verifySignature(post))) {
      throw new InvalidCallbackError('SSLCommerz signature does not match.', this.name, post);
    }

    // Signed or not, the validation API is the source of truth.
    const validated = await this.validate(request.string('val_id'), payment);

    return this.complete(payment, validated, step);
  }

  /**
   * SSLCommerz's own hash scheme: md5 of "key=value&..." over the keys listed in
   * verify_key plus store_passwd=md5(store password), keys sorted.
   */
  async verifySignature(post: JsonObject): Promise<boolean> {
    const { createHash } = await nodeCrypto();
    const md5 = (value: string): string => createHash('md5').update(value).digest('hex');
    const fields = new Map<string, string>();

    for (const key of text(post, 'verify_key').split(',')) {
      // Empty entries are skipped ("0" too, as the reference implementation does).
      if (key !== '' && key !== '0') {
        fields.set(key, text(post, key));
      }
    }

    fields.set('store_passwd', md5(this.credential('storePassword')));

    const pairs = [...fields.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => `${key}=${fields.get(key) ?? ''}`);

    return safeEqual(md5(pairs.join('&')), text(post, 'verify_sign'));
  }

  /** Server-to-server validation of a val_id. Never trust the redirect alone. */
  async validate(valId: string, payment: Payment): Promise<JsonObject> {
    if (valId === '') {
      throw new InvalidCallbackError('SSLCommerz callback has no val_id to validate.', this.name);
    }

    const { data } = await this.http(`${this.baseUrl}/validator/api/validationserverAPI.php`, {
      method: 'GET',
      query: {
        val_id: valId,
        store_id: this.credential('storeId'),
        store_passwd: this.credential('storePassword'),
        v: 1,
        format: 'json',
      },
    });

    const status = (field(data, 'status') ?? '').toUpperCase();

    if (!PAID.includes(status)) {
      throw new InvalidCallbackError(
        `SSLCommerz validation API rejected val_id ${valId} (${status || 'no status'}).`,
        this.name,
        data,
      );
    }

    if ((field(data, 'tran_id') ?? '') !== payment.gatewayReference) {
      throw new InvalidCallbackError('SSLCommerz validation returned a different tran_id.', this.name, data);
    }

    return data;
  }

  /**
   * Ask SSLCommerz about every transaction under this tran_id. Completes the
   * payment if one was paid; null when nothing paid was found.
   */
  private async query(payment: Payment): Promise<CallbackResult | null> {
    const { data } = await this.http(`${this.baseUrl}/validator/api/merchantTransIDvalidationAPI.php`, {
      method: 'GET',
      query: {
        tran_id: payment.gatewayReference,
        store_id: this.credential('storeId'),
        store_passwd: this.credential('storePassword'),
        v: 1,
        format: 'json',
      },
    });

    for (const element of list(data, 'element')) {
      if (isObject(element) && PAID.includes((field(element, 'status') ?? '').toUpperCase())) {
        return this.complete(payment, element, 'query');
      }
    }

    await this.save(this.log(payment, 'query', data));

    return null;
  }

  /** `data` is a validation API response or a query element. */
  private async complete(payment: Payment, data: JsonObject, step: string): Promise<CallbackResult> {
    // "amount" is converted to BDT for foreign-currency payments; the
    // original currency and amount are what must match.
    const currencyType = field(data, 'currency_type');

    if (currencyType !== null && currencyType !== '0') {
      this.assertAmountMatches(payment, data.currency_amount, currencyType);
    } else {
      this.assertAmountMatches(payment, data.amount);
    }

    return this.transition(
      payment,
      PaymentStatus.Completed,
      {
        gatewayTransactionId: field(data, 'bank_tran_id'),
        // risk_level 1: SSLCommerz asks you to hold the service and verify the customer.
        requiresReview: (field(data, 'risk_level') ?? '0') === '1',
      },
      step,
      data,
    );
  }

  override async sync(payment: Payment): Promise<Payment> {
    await this.query(payment);

    return this.reload(payment);
  }

  protected override async requestRefund(
    payment: Payment,
    amount: string,
    reason: string | null,
  ): Promise<RefundResult> {
    if (!payment.gatewayTransactionId) {
      throw new GatewayError('SSLCommerz needs bank_tran_id to refund; sync the payment first.', this.name);
    }

    const refundTransId = `RF${randomString(18)}`;

    const { data } = await this.http(`${this.baseUrl}/validator/api/merchantTransIDvalidationAPI.php`, {
      method: 'GET',
      query: {
        bank_tran_id: payment.gatewayTransactionId,
        refund_trans_id: refundTransId,
        refund_amount: amount,
        refund_remarks: reason ?? `Refund for ${payment.reference}`,
        refe_id: payment.gatewayReference,
        store_id: this.credential('storeId'),
        store_passwd: this.credential('storePassword'),
        v: 1,
        format: 'json',
      },
    });

    // "success" means initiated; the bank settles it later. "processing"
    // means this refund was already initiated, so it is not a new one.
    const status = (field(data, 'status') ?? '').toLowerCase();
    const accepted = data.APIConnect === 'DONE' && status === 'success';

    return this.refundResult(payment, {
      accepted,
      amount,
      refundId: field(data, 'refund_ref_id'),
      message:
        field(data, 'errorReason') ??
        (status === 'processing' ? 'Refund already initiated' : field(data, 'status')),
      raw: { refund_trans_id: refundTransId, ...data },
      pending: accepted,
    });
  }

  /** Status of a refund previously initiated: refunded, processing or cancelled. */
  async refundStatus(refundRefId: string): Promise<string> {
    const { data } = await this.http(`${this.baseUrl}/validator/api/merchantTransIDvalidationAPI.php`, {
      method: 'GET',
      query: {
        refund_ref_id: refundRefId,
        store_id: this.credential('storeId'),
        store_passwd: this.credential('storePassword'),
        format: 'json',
      },
    });

    return (field(data, 'status') ?? 'unknown').toLowerCase();
  }
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** A scalar value as a string, or null. */
function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null;
}

/** A signed callback field as text. An array or object cannot be a signed field: malformed. */
function text(post: JsonObject, key: string): string {
  const value = post[key];

  if (value === undefined || value === null) {
    return '';
  }

  const string = scalar(value);

  if (string === null) {
    throw new MalformedCallbackError(`Callback parameter [${key}] must be a single value.`);
  }

  return string;
}
