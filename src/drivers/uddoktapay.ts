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
import { object, safeEqual, str } from '../core/util.js';

/**
 * UddoktaPay checkout-v2. UddoktaPay is self-hosted software, not a licensed
 * gateway: each merchant runs it on their own domain, so `baseUrl` is the
 * merchant's install (only the public sandbox host is built in).
 *
 * UddoktaPay generates the invoice_id when the customer submits a payment;
 * nothing identifies the payment before that. Our attempt id travels in
 * "metadata", and the payment is found from the verify-payment response,
 * never from the callback body. The webhook only echoes the API key, so it
 * is verified with verify-payment too.
 *
 * No refunds: /api/refund-payment exists but its response is undocumented.
 *
 * Config: apiKey, baseUrl (required outside the sandbox), sandbox.
 *
 * Docs: https://uddoktapay.readme.io/reference/overview
 */
export class UddoktaPayGateway extends AbstractGateway {
  static override readonly driver = 'uddoktapay';

  static readonly SANDBOX_URL = 'https://sandbox.uddoktapay.com';

  static readonly API_KEY_HEADER = 'RT-UDDOKTAPAY-API-KEY';

  override readonly capabilities: Capabilities = { sync: true, refunds: false };

  get baseUrl(): string {
    const custom = this.config.baseUrl;

    if (!this.sandbox && (typeof custom !== 'string' || custom.trim() === '')) {
      throw new GatewayError(
        `Missing [baseUrl] in the [${this.name}] gateway config: UddoktaPay runs on your own domain.`,
        this.name,
      );
    }

    // Accept the panel URL or a pasted API URL ("https://pay.example.com/api/checkout-v2").
    return this.endpoint(UddoktaPayGateway.SANDBOX_URL, UddoktaPayGateway.SANDBOX_URL).replace(
      /\/api(\/.*)?$/i,
      '',
    );
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    if (this.currency !== 'BDT') {
      throw new GatewayError('UddoktaPay checkout-v2 accepts BDT only.', this.name);
    }

    const payment = await this.createPendingPayment(options);
    const headers = this.headers();

    const response = await this.http(`${this.baseUrl}/api/checkout-v2`, {
      method: 'POST',
      headers,
      json: {
        full_name: options.customer.name ?? '',
        email: options.customer.email ?? 'noemail@example.com',
        amount: payment.amount,
        metadata: {
          gateway_reference: payment.gatewayReference,
          reference: payment.reference,
          payment_id: payment.id,
        },
        // invoice_id is appended to redirect_url, so it carries no query of its own.
        redirect_url: this.callbackUrl('success'),
        return_type: 'GET',
        // The cancel link is used as given, with no invoice_id: our reference rides along.
        cancel_url: this.callbackUrl('cancel', { ref: payment.gatewayReference }),
        webhook_url: this.callbackUrl('ipn'),
      },
    });
    const data = response.data;

    if (!response.ok || data.status !== true || !str(data.payment_url)) {
      await this.save(this.log(payment, 'create', data));

      throw new GatewayError(
        `UddoktaPay could not create the payment: ${isSet(data.message) ? str(data.message) : `HTTP ${response.status}`}`,
        this.name,
        data,
      );
    }

    payment.checkoutUrl = str(data.payment_url);

    return this.save(this.log(payment, 'create', data));
  }

  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    if (outcome === 'ipn') {
      this.assertWebhookKey(request);
    }

    const invoiceId = request.string('invoice_id');

    if (outcome === 'cancel') {
      return this.handleCancel(request, invoiceId);
    }

    if (invoiceId === '') {
      throw new InvalidCallbackError('UddoktaPay callback has no invoice_id.', this.name, request.all());
    }

    const data = await this.verify(invoiceId);

    return this.apply(await this.paymentFor(data, invoiceId), invoiceId, data, outcome);
  }

  /**
   * The customer left the checkout page. UddoktaPay has no invoice for a
   * payment nobody submitted, so there is nothing to confirm a cancel
   * against: the attempt stays pending unless a known invoice says it was paid.
   */
  private async handleCancel(request: CallbackRequest, invoiceId: string): Promise<CallbackResult> {
    const payment = await this.findByGatewayReference(request.queryString('ref'));
    const invoice = invoiceId !== '' ? invoiceId : (payment.gatewayPaymentId ?? '');

    if (invoice === '') {
      return this.stillPending(payment, 'cancel', {
        note: 'Cancelled before any payment was submitted; nothing to verify.',
      });
    }

    const data = await this.verify(invoice);

    if ((await this.paymentFor(data, invoice)).id !== payment.id) {
      throw new InvalidCallbackError('UddoktaPay invoice belongs to a different payment.', this.name, data);
    }

    return this.apply(payment, invoice, data, 'cancel');
  }

  override async sync(payment: Payment): Promise<Payment> {
    const invoiceId = payment.gatewayPaymentId;

    // No invoice_id yet: the customer has not submitted a payment, and
    // UddoktaPay has nothing to look up.
    if (!invoiceId) {
      return this.reload(payment);
    }

    const data = await this.verify(invoiceId);

    if ((await this.paymentFor(data, invoiceId)).id !== payment.id) {
      throw new InvalidCallbackError('UddoktaPay invoice belongs to a different payment.', this.name, data);
    }

    await this.apply(payment, invoiceId, data, 'sync');

    return this.reload(payment);
  }

  /**
   * POST /api/verify-payment. Returns the payment, or status "ERROR" with a
   * message ("No Data Found") for an unknown invoice.
   */
  async verify(invoiceId: string): Promise<JsonObject> {
    const response = await this.http(`${this.baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: this.headers(),
      json: { invoice_id: invoiceId },
    });

    if (response.status >= 500) {
      throw new GatewayUnavailableError(
        `UddoktaPay verify-payment failed with HTTP ${response.status}.`,
        this.name,
        response.data,
      );
    }

    return response.data;
  }

  /** The payment a verified invoice belongs to, from the metadata we sent. */
  private async paymentFor(data: JsonObject, invoiceId: string): Promise<Payment> {
    const status = str(data.status).toUpperCase();

    if (status !== 'COMPLETED' && status !== 'PENDING') {
      throw new InvalidCallbackError(
        `UddoktaPay has no payment for invoice [${invoiceId}]: ${isSet(data.message) ? str(data.message) : status || 'no status'}`,
        this.name,
        data,
      );
    }

    if (isSet(data.invoice_id) && str(data.invoice_id) !== invoiceId) {
      throw new InvalidCallbackError('UddoktaPay verified a different invoice_id.', this.name, data);
    }

    return this.findByGatewayReference(str(object(data, 'metadata').gateway_reference));
  }

  /** `data` is a verify-payment response for this payment. */
  private async apply(
    payment: Payment,
    invoiceId: string,
    data: JsonObject,
    step: string,
  ): Promise<CallbackResult> {
    if (str(data.status).toUpperCase() === 'COMPLETED') {
      this.assertAmountMatches(payment, data.amount ?? null);

      const transactionId = str(data.transaction_id);

      return this.transition(
        payment,
        PaymentStatus.Completed,
        { gatewayPaymentId: invoiceId, gatewayTransactionId: transactionId !== '' ? transactionId : null },
        step,
        data,
      );
    }

    // PENDING: submitted, waiting for the merchant (or the software) to
    // match it. Keep the invoice_id so sync can ask again.
    if (this.isPending(payment)) {
      payment.gatewayPaymentId = invoiceId;
    }

    return this.stillPending(payment, step, data);
  }

  /**
   * The webhook carries our own API key in a header, nothing more. A
   * mismatch is rejected; a match still goes through verify-payment.
   */
  private assertWebhookKey(request: CallbackRequest): void {
    const key = request.header(UddoktaPayGateway.API_KEY_HEADER) ?? '';

    if (key === '' || !safeEqual(this.credential('apiKey'), key)) {
      throw new InvalidCallbackError('UddoktaPay webhook API key does not match.', this.name);
    }
  }

  private headers(): Record<string, string> {
    return { [UddoktaPayGateway.API_KEY_HEADER]: this.credential('apiKey') };
  }
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}
