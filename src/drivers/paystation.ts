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
import { isObject, str } from '../core/util.js';

/**
 * PayStation hosted checkout (Service Hub Ltd): cards, bKash, Nagad, Rocket, Upay.
 *
 * Business errors come back as HTTP 200 with a string "status_code" other
 * than "200". There is no refund API and no request signing: the browser
 * return is plain query parameters, so every outcome is confirmed with the
 * transaction status API, looked up by our invoice number.
 *
 * Config: merchantId, password, sandbox, payWithCharge (default false: the
 * merchant bears PayStation's charge).
 *
 * Docs: https://paystation.com.bd/documentation
 */
export class PayStationGateway extends AbstractGateway {
  static override readonly driver = 'paystation';

  static readonly SANDBOX_URL = 'https://sandbox.paystation.com.bd';
  static readonly LIVE_URL = 'https://api.paystation.com.bd';

  override readonly capabilities: Capabilities = { sync: true, refunds: false };

  get baseUrl(): string {
    return this.endpoint(PayStationGateway.SANDBOX_URL, PayStationGateway.LIVE_URL);
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    const payment = await this.createPendingPayment(options);
    const customer = options.customer;

    const body: Record<string, string | number> = {
      merchantId: this.credential('merchantId'),
      password: this.credential('password'),
      invoice_number: payment.gatewayReference,
      currency: payment.currency,
      payment_amount: payment.amount,
      reference: payment.reference,
      cust_name: customer.name ?? '',
      cust_phone: customer.phone ?? '',
      cust_email: customer.email ?? 'noemail@example.com',
      cust_address: customer.address ?? customer.city ?? 'Dhaka',
      callback_url: this.callbackUrl('callback'),
      checkout_items: options.description ?? payment.reference,
      opt_a: payment.id,
    };

    if (this.payWithCharge) {
      body.pay_with_charge = 1;
    }

    const response = await this.http(`${this.baseUrl}/initiate-payment`, { method: 'POST', form: body });
    const data = response.data;

    if (!response.ok || str(data.status_code) !== '200' || !str(data.payment_url)) {
      await this.save(this.log(payment, 'create', data));

      const reason = isSet(data.message)
        ? `${str(data.message)}${isSet(data.status_code) ? ` (${str(data.status_code)})` : ''}`
        : `HTTP ${response.status}`;

      throw new GatewayError(`PayStation could not create the payment: ${reason}`, this.name, data);
    }

    payment.checkoutUrl = str(data.payment_url);

    return this.save(this.log(payment, 'create', data));
  }

  /**
   * The customer comes back to callback_url with ?status=Successful|Failed|Canceled
   * &invoice_number=...&trx_id=... None of it is trusted: the status API decides.
   */
  async handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult> {
    const payment = await this.findByGatewayReference(request.string('invoice_number'));
    const claim = request.string('status').toLowerCase();

    return this.apply(
      payment,
      await this.transactionStatus(payment),
      outcome,
      claim === 'canceled' || claim === 'cancelled',
    );
  }

  override async sync(payment: Payment): Promise<Payment> {
    await this.apply(payment, await this.transactionStatus(payment), 'sync');

    return this.reload(payment);
  }

  /**
   * POST /transaction-status by invoice number. Authenticated by the
   * merchantId header only, as PayStation documents it.
   */
  async transactionStatus(payment: Payment): Promise<JsonObject> {
    const response = await this.http(`${this.baseUrl}/transaction-status`, {
      method: 'POST',
      headers: { merchantId: this.credential('merchantId') },
      json: { invoice_number: payment.gatewayReference },
    });

    return response.data;
  }

  /** `response` is a transaction status response. */
  private async apply(
    payment: Payment,
    response: JsonObject,
    step: string,
    cancelled = false,
  ): Promise<CallbackResult> {
    const data = response.data;

    // "Transaction not found", "Invalid Token.", a non-JSON body: none of
    // these says the payment failed. Leave it pending and sync later.
    if (str(response.status_code) !== '200' || data === null || typeof data !== 'object') {
      return this.stillPending(payment, step, response);
    }

    const transaction: JsonObject = isObject(data) ? data : {};

    if (str(transaction.invoice_number) !== payment.gatewayReference) {
      throw new InvalidCallbackError('PayStation returned a different invoice_number.', this.name, response);
    }

    // The docs list "success"/"failed" and the samples "Success"/"Failed", but
    // the live sandbox answers "successful" (seen 2026-10-15). Accept all.
    switch (str(transaction.trx_status).trim().toLowerCase()) {
      case 'success':
      case 'successful':
        return this.complete(payment, transaction, step, response);
      case 'failed':
      case 'failure':
        return this.transition(
          payment,
          cancelled ? PaymentStatus.Cancelled : PaymentStatus.Failed,
          {
            failureReason: cancelled ? 'Cancelled by customer' : 'PayStation reported the transaction failed',
          },
          step,
          response,
        );
      default:
        // "processing": started, not finished. "refund": refunded at
        // PayStation before we saw it paid; logged for a human to look at.
        return this.stillPending(payment, step, response);
    }
  }

  private async complete(
    payment: Payment,
    data: JsonObject,
    step: string,
    response: JsonObject,
  ): Promise<CallbackResult> {
    // request_amount is what we asked for. When the customer does not bear
    // the charge, what was paid (payment_amount) must be exactly that too.
    this.assertAmountMatches(payment, data.request_amount ?? data.payment_amount ?? null);

    if (!this.payWithCharge && isSet(data.request_amount) && isSet(data.payment_amount)) {
      this.assertAmountMatches(payment, data.payment_amount);
    }

    const trxId = str(data.trx_id);

    return this.transition(
      payment,
      PaymentStatus.Completed,
      { gatewayTransactionId: trxId !== '' ? trxId : null },
      step,
      response,
    );
  }

  private get payWithCharge(): boolean {
    const value = this.config.payWithCharge;

    return Boolean(value) && value !== '0';
  }
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}
