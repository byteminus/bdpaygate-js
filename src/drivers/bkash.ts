import { GatewayError, GatewayUnavailableError, InvalidCallbackError } from '../core/errors.js';
import { AbstractGateway } from '../core/gateway.js';
import type { HttpResponse } from '../core/http.js';
import { gatewayResponse, toFixed2 } from '../core/payment.js';
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
import { field, isObject, limit, list, safeEqual } from '../core/util.js';

type Operation = 'grant' | 'refresh' | 'create' | 'execute' | 'query' | 'refund' | 'refundStatus';

interface Problem {
  code: string;
  message: string;
}

interface Query {
  response: HttpResponse;
  data: JsonObject;
}

export interface BkashRefundStatus {
  originalTrxId: string | null;
  refunds: {
    refundTrxId: string | null;
    status: string | null;
    amount: string | null;
    completedAt: string | null;
  }[];
  raw: JsonObject;
}

const V2_PATHS: Record<Operation, string> = {
  grant: '/v2/tokenized-checkout/auth/grant-token',
  refresh: '/v2/tokenized-checkout/auth/refresh-token',
  create: '/v2/tokenized-checkout/payment/create',
  execute: '/v2/tokenized-checkout/payment/execute',
  query: '/v2/tokenized-checkout/query/payment',
  refund: '/v2/tokenized-checkout/refund/payment/transaction',
  refundStatus: '/v2/tokenized-checkout/refund/payment/status',
};

const V1_PATHS: Record<Operation, string> = {
  grant: '/v1.2.0-beta/tokenized/checkout/token/grant',
  refresh: '/v1.2.0-beta/tokenized/checkout/token/refresh',
  create: '/v1.2.0-beta/tokenized/checkout/create',
  execute: '/v1.2.0-beta/tokenized/checkout/execute',
  query: '/v1.2.0-beta/tokenized/checkout/payment/status',
  // bKash's v1.2.0-beta refund pages point at the V2 refund API.
  refund: '/v2/tokenized-checkout/refund/payment/transaction',
  refundStatus: '/v2/tokenized-checkout/refund/payment/status',
};

/**
 * Execute errors that are a definite decline. Anything else (2056 Invalid
 * Payment State, 2003, 2020, 503, HTTP 5xx...) is ambiguous and stays
 * pending. Every execute error is checked with Query first, so "already
 * completed" (2062, 2068, 2117) completes the payment.
 */
const DECLINED = new Set([
  '2006',
  '2007',
  '2009',
  '2010',
  '2011',
  '2013',
  '2014',
  '2015',
  '2016',
  '2017',
  '2018',
  '2019',
  '2023',
  '2029',
  '2037',
  '2038',
  '2039',
  '2040',
  '2041',
  '2043',
  '2044',
  '2045',
  '2046',
  '2057',
  '2058',
]);

/** Query transactionStatus values that settle a payment as not paid. */
const UNPAID_STATES: Record<string, PaymentStatus> = {
  Failed: PaymentStatus.Failed,
  Declined: PaymentStatus.Failed,
  Expired: PaymentStatus.Failed,
  Cancelled: PaymentStatus.Cancelled,
};

/**
 * bKash Tokenized Checkout (URL based, without agreement).
 *
 * Tokenized V2 by default; set `version: 'v1.2'` for merchants still on
 * v1.2.0-beta. Refunds use the V2 refund API on both, as bKash documents.
 *
 * Config: appKey, appSecret, username, password, sandbox, version,
 * verifySignature (default true), executeOnSync (default true).
 *
 * Docs: https://developer.bka.sh/docs/tokenized-without-agreement
 */
export class BkashGateway extends AbstractGateway {
  static override readonly driver = 'bkash';

  static readonly SANDBOX_URL = 'https://tokenized.sandbox.bka.sh';
  static readonly LIVE_URL = 'https://tokenized.pay.bka.sh';

  /** Grant and refresh together, per hour. One more and bKash blocks the merchant's token calls for an hour. */
  static readonly TOKEN_CALLS_PER_HOUR = 2;

  /** bKash allows at most this many (partial) refunds per transaction. */
  static readonly MAX_REFUNDS = 10;

  override readonly capabilities: Capabilities = { sync: true, refunds: 'partial' };

  get baseUrl(): string {
    return this.endpoint(BkashGateway.SANDBOX_URL, BkashGateway.LIVE_URL);
  }

  /** "v2" (Tokenized V2, the default) or "v1.2" (v1.2.0-beta). */
  get version(): 'v2' | 'v1.2' {
    return this.option('version', 'v2').toLowerCase().includes('1.2') ? 'v1.2' : 'v2';
  }

  private get legacy(): boolean {
    return this.version === 'v1.2';
  }

  private url(operation: Operation): string {
    return this.baseUrl + (this.legacy ? V1_PATHS : V2_PATHS)[operation];
  }

  async charge(options: ChargeOptions): Promise<Payment> {
    if (this.currency !== 'BDT') {
      throw new GatewayError('bKash only accepts BDT.', this.name);
    }

    const payment = await this.createPendingPayment(options);
    const payer = clean(options.customer.phone ?? '') || clean(options.reference) || payment.gatewayReference;

    let body: JsonObject = {
      payerReference: payer,
      callbackURL: this.callbackUrl('callback'),
      amount: payment.amount,
      currency: payment.currency,
      intent: 'sale',
      merchantInvoiceNumber: payment.gatewayReference,
    };

    if (this.legacy) {
      body = { mode: this.option('mode', '0011'), ...body };
    }

    const { response, data } = await this.call('create', body);
    const paymentId = field(data, 'paymentId', 'paymentID');
    const problem = this.problem(response, data);

    this.log(payment, 'create', data);

    if (problem || paymentId === null || !field(data, 'bkashURL')) {
      await this.save(payment);

      throw new GatewayError(
        `bKash could not create the payment: ${problem ? describe(problem) : 'unexpected response'}`,
        this.name,
        data,
      );
    }

    payment.gatewayPaymentId = paymentId;
    payment.checkoutUrl = field(data, 'bkashURL');

    return this.save(payment);
  }

  /**
   * bKash sends the customer back with ?paymentID=&status=success|failure|cancel&signature=.
   * None of it is trusted: success means "execute now", the rest are claims
   * checked with Query Payment first.
   */
  async handleCallback(request: CallbackRequest, _outcome: Outcome): Promise<CallbackResult> {
    const paymentId = request.first('paymentID', 'paymentId');

    if (paymentId === '') {
      throw new InvalidCallbackError('bKash callback has no paymentID.', this.name, request.all());
    }

    const payment = await this.findByGatewayPaymentId(paymentId);
    const status = request.string('status').toLowerCase();

    this.verifySignature(payment, status, request.string('signature'), request.all());

    if (this.isPaid(payment)) {
      return this.unchanged(payment);
    }

    if (status === 'success') {
      return this.execute(payment);
    }

    const settled = await this.settle(payment, await this.queryPayment(payment));

    if (settled.changed || !this.isPending(settled.payment)) {
      return settled;
    }

    const cancelled = status === 'cancel';

    return this.transition(
      payment,
      cancelled ? PaymentStatus.Cancelled : PaymentStatus.Failed,
      {
        failureReason: cancelled
          ? 'Cancelled by the customer on bKash'
          : 'bKash reported the payment as failed',
      },
      'callback',
      request.all(),
    );
  }

  /**
   * Compare the callback's signature with the one bKash issued for this
   * outcome in the Create Payment response. Skipped when none was issued.
   */
  private verifySignature(payment: Payment, status: string, signature: string, params: JsonObject): void {
    if (this.config.verifySignature === false) {
      return;
    }

    const expected = this.expectedSignature(payment, status);

    if (expected !== null && !safeEqual(expected, signature)) {
      throw new InvalidCallbackError(
        'bKash callback signature does not match the one issued for this payment.',
        this.name,
        params,
      );
    }
  }

  private expectedSignature(payment: Payment, status: string): string | null {
    const create = gatewayResponse(payment, 'create') ?? {};
    const key =
      status === 'success'
        ? 'successCallbackURL'
        : status === 'cancel'
          ? 'cancelledCallbackURL'
          : 'failureCallbackURL';
    const url = create[key];

    if (typeof url === 'string') {
      try {
        const signature = new URL(url).searchParams.get('signature');

        if (signature) {
          return signature;
        }
      } catch {
        // Not a URL; fall back to the top-level signature.
      }
    }

    return field(create, 'signature');
  }

  /**
   * Execute the payment the customer authorised: this is what moves the
   * money. A paymentID can be executed once, whatever the result, so a
   * second callback (refresh, back button, a concurrent request) queries.
   */
  private async execute(payment: Payment): Promise<CallbackResult> {
    const release = this.executeAttempted(payment)
      ? null
      : await this.tryLock(`bkash:execute:${payment.id}`, 60);

    if (!release) {
      return this.settle(payment, await this.queryPayment(payment));
    }

    try {
      await this.save(this.log(payment, 'execute_attempt', { paymentId: payment.gatewayPaymentId }));

      let result: Query;

      try {
        result = await this.call('execute', { [this.paymentIdKey]: payment.gatewayPaymentId });
      } catch (error) {
        if (error instanceof GatewayUnavailableError) {
          // "A timeout isn't a failure": ask Query. If that is down too,
          // the error reaches the handler and the payment stays pending.
          return this.settle(payment, await this.queryPayment(payment));
        }

        throw error;
      }

      const problem = this.problem(result.response, result.data);

      if (problem === null && result.data.transactionStatus === 'Completed') {
        return this.complete(payment, result.data, 'execute');
      }

      await this.save(this.log(payment, 'execute', result.data));

      return this.settle(payment, await this.queryPayment(payment), problem);
    } finally {
      await release();
    }
  }

  private executeAttempted(payment: Payment): boolean {
    return gatewayResponse(payment, 'execute_attempt') !== null;
  }

  private async queryPayment(payment: Payment): Promise<Query> {
    if (!payment.gatewayPaymentId) {
      throw new GatewayError('This bKash payment was never created at bKash; nothing to query.', this.name);
    }

    return this.call('query', { [this.paymentIdKey]: payment.gatewayPaymentId });
  }

  /**
   * Apply what Query Payment said. Completed completes; a definite decline
   * (from Query, or from the execute call before it) fails; anything else,
   * including "Initiated" right after an execute attempt, stays pending.
   */
  private async settle(
    payment: Payment,
    query: Query,
    executeProblem: Problem | null = null,
  ): Promise<CallbackResult> {
    const data = query.data;
    const state = this.problem(query.response, data) === null ? (field(data, 'transactionStatus') ?? '') : '';
    const unpaid = UNPAID_STATES[state];

    if (state === 'Completed') {
      return this.complete(payment, data, 'query');
    }

    if (unpaid) {
      return this.transition(payment, unpaid, { failureReason: `bKash: ${state}` }, 'query', data);
    }

    if (executeProblem && DECLINED.has(executeProblem.code)) {
      return this.transition(
        payment,
        PaymentStatus.Failed,
        { failureReason: describe(executeProblem) },
        'query',
        data,
      );
    }

    // A paymentID lives 24 hours. Still not Completed after that, it never will be.
    if (state === 'Initiated' && !this.withinLifetime(payment, 5)) {
      return this.transition(
        payment,
        PaymentStatus.Failed,
        { failureReason: 'bKash: Expired (paymentID older than 24 hours)' },
        'query',
        data,
      );
    }

    return this.stillPending(
      payment,
      'query',
      executeProblem ? { ...data, execute_error: { ...executeProblem } } : data,
    );
  }

  /** A paymentID can be executed for 24 hours after Create Payment. */
  private withinLifetime(payment: Payment, graceMinutes = 0): boolean {
    return new Date(payment.createdAt).getTime() > Date.now() - (24 * 60 + graceMinutes) * 60_000;
  }

  /** `data` is an execute or query response saying Completed. */
  private async complete(payment: Payment, data: JsonObject, step: string): Promise<CallbackResult> {
    const reportedId = field(data, 'paymentId', 'paymentID');

    if (reportedId !== null && reportedId !== payment.gatewayPaymentId) {
      throw new InvalidCallbackError('bKash answered about a different paymentID.', this.name, data);
    }

    try {
      this.assertAmountMatches(payment, data.amount, field(data, 'currency'));
    } catch (error) {
      // bKash says the money moved, but not the amount we asked for. Keep it for a human.
      payment.requiresReview = true;
      await this.save(this.log(payment, `${step}_mismatch`, data));

      throw error;
    }

    return this.transition(
      payment,
      PaymentStatus.Completed,
      { gatewayTransactionId: field(data, 'trxId', 'trxID'), failureReason: null },
      step,
      data,
    );
  }

  /**
   * Ask bKash for the current state. A pending payment the customer verified
   * but whose callback never arrived is executed here (within its 24 hours),
   * unless `executeOnSync` is false.
   */
  override async sync(payment: Payment): Promise<Payment> {
    if (!payment.gatewayPaymentId || this.isPaid(payment)) {
      return payment;
    }

    const query = await this.queryPayment(payment);
    const data = query.data;

    const verifiedButNotExecuted =
      this.isPending(payment) &&
      this.config.executeOnSync !== false &&
      !this.executeAttempted(payment) &&
      this.problem(query.response, data) === null &&
      data.transactionStatus === 'Initiated' &&
      (data.verificationStatus ?? data.userVerificationStatus) === 'Complete' &&
      this.withinLifetime(payment);

    await (verifiedButNotExecuted ? this.execute(payment) : this.settle(payment, query));

    return this.reload(payment);
  }

  protected override async requestRefund(
    payment: Payment,
    amount: string,
    reason: string | null,
  ): Promise<RefundResult> {
    if (!payment.gatewayTransactionId || !payment.gatewayPaymentId) {
      throw new GatewayError(
        'bKash needs the paymentID and trxID to refund; sync the payment first.',
        this.name,
      );
    }

    const refunds = payment.gatewayResponse.filter((entry) => entry.step === 'refund').length;

    if (refunds >= BkashGateway.MAX_REFUNDS) {
      throw new GatewayError(
        `bKash allows at most ${BkashGateway.MAX_REFUNDS} refunds per transaction.`,
        this.name,
      );
    }

    const max = this.maxRefundable(payment);

    if (max !== null && Number(payment.refundedAmount) + Number(amount) > Number(max) + 0.001) {
      throw new GatewayError(
        `bKash will refund at most ${max} for this payment (coupon or discount excluded); ${payment.refundedAmount} already refunded.`,
        this.name,
      );
    }

    const body = {
      paymentId: payment.gatewayPaymentId,
      trxId: payment.gatewayTransactionId,
      refundAmount: amount,
      sku: limit(clean(payment.reference) || payment.gatewayReference, 255),
      reason: limit(clean(reason ?? '') || `Refund for ${clean(payment.reference)}`, 255),
    };

    let result: Query;

    try {
      result = await this.call('refund', body);
    } catch (error) {
      if (!(error instanceof GatewayUnavailableError)) {
        throw error;
      }

      // It may have gone through. Counted as pending so it is not sent
      // twice (bKash also rejects a duplicate within 10 minutes); check
      // refundStatus() to see whether it landed.
      return this.refundResult(payment, {
        accepted: true,
        pending: true,
        amount,
        message: 'bKash did not answer in time. Check refundStatus() before refunding again.',
        raw: { request: body, timeout: error.message },
      });
    }

    const problem = this.problem(result.response, result.data);
    const refundId = field(result.data, 'refundTrxId', 'refundTrxID');
    const status = field(result.data, 'refundTransactionStatus', 'transactionStatus') ?? '';
    const accepted = problem === null && refundId !== null;

    return this.refundResult(payment, {
      accepted,
      amount,
      refundId,
      message: problem ? describe(problem) : status || null,
      raw: result.data,
      pending: accepted && status !== 'Completed',
    });
  }

  /**
   * Every refund bKash holds for this payment, from the Refund Status API.
   * Call it after a refund timed out, before refunding again.
   */
  async refundStatus(payment: Payment): Promise<BkashRefundStatus> {
    if (!payment.gatewayTransactionId || !payment.gatewayPaymentId) {
      throw new GatewayError('bKash needs the paymentID and trxID for a refund status.', this.name);
    }

    const { response, data } = await this.call('refundStatus', {
      paymentId: payment.gatewayPaymentId,
      trxId: payment.gatewayTransactionId,
    });
    const problem = this.problem(response, data);

    if (problem) {
      throw new GatewayError(`bKash refund status failed: ${describe(problem)}`, this.name, data);
    }

    return {
      originalTrxId: field(data, 'originalTrxId', 'originalTrxID'),
      refunds: list(data, 'refundTransactions')
        .filter(isObject)
        .map((refund) => ({
          refundTrxId: field(refund, 'refundTrxId', 'refundTrxID'),
          status: field(refund, 'refundTransactionStatus', 'transactionStatus'),
          amount: field(refund, 'refundAmount', 'amount'),
          completedAt: field(refund, 'completedTime'),
        })),
      raw: data,
    };
  }

  /** maxRefundableAmount from the Completed execute/query response. Lower than the amount when a coupon was applied. */
  private maxRefundable(payment: Payment): string | null {
    for (const entry of [...payment.gatewayResponse].reverse()) {
      const max = Number(entry.payload.maxRefundableAmount);

      if (
        entry.payload.transactionStatus === 'Completed' &&
        entry.payload.maxRefundableAmount !== undefined &&
        Number.isFinite(max)
      ) {
        return toFixed2(max);
      }
    }

    return null;
  }

  /** An authenticated API call. If bKash rejects the token, it is dropped and the call retried once with a fresh one. */
  private async call(operation: Operation, body: JsonObject, retry = true): Promise<Query> {
    const token = await this.token();
    const response = await this.http(this.url(operation), {
      method: 'POST',
      headers: { authorization: token, 'x-app-key': this.credential('appKey') },
      json: body,
    });

    if (retry && this.isAuthError(response, response.data)) {
      // Only drop it if nobody has replaced it meanwhile.
      const key = this.tokenKey('id_token');

      if ((await this.ctx.cache.get(await this.tokenCacheKey(key))) === token) {
        await this.forgetToken(key);
      }

      return this.call(operation, body, false);
    }

    return { response, data: response.data };
  }

  private isAuthError(response: HttpResponse, data: JsonObject): boolean {
    if (response.status === 401 || response.status === 403) {
      return true;
    }

    const code = this.problem(response, data)?.code ?? null;

    if (code === '2079') {
      return true;
    }

    const message = (field(data, 'message', 'Message') ?? '').toLowerCase();

    return code === null && message !== '' && (message.includes('unauthorized') || message.includes('token'));
  }

  /**
   * The id_token, from cache. When it has expired the refresh token is used,
   * and only without one (or if bKash refuses it) is a new token granted.
   */
  async token(): Promise<string> {
    return this.rememberToken(this.tokenKey('id_token'), async () => {
      const refreshKey = await this.tokenCacheKey(this.tokenKey('refresh_token'));
      const refreshToken = await this.ctx.cache.get(refreshKey);
      let data: JsonObject | null = null;

      if (typeof refreshToken === 'string' && refreshToken !== '') {
        try {
          data = await this.tokenRequest('refresh', { refresh_token: refreshToken });
        } catch (error) {
          if (error instanceof GatewayUnavailableError || !(error instanceof GatewayError)) {
            throw error;
          }

          await this.ctx.cache.delete(refreshKey);
        }
      }

      data ??= await this.tokenRequest('grant');

      const newRefresh = field(data, 'refresh_token');

      if (newRefresh) {
        // Valid 30 days on V2, 28 on v1.2.0-beta.
        await this.ctx.cache.set(refreshKey, newRefresh, 27 * 24 * 3600);
      }

      const expiresIn = Number(data.expires_in ?? 3600) || 3600;

      // bKash asks for a refresh around minute 50 of the hour.
      return [field(data, 'id_token') ?? '', expiresIn > 1200 ? expiresIn - 600 : Math.floor(expiresIn / 2)];
    });
  }

  private async tokenRequest(
    operation: 'grant' | 'refresh',
    extra: Record<string, string> = {},
  ): Promise<JsonObject> {
    await this.countTokenCall();

    const response = await this.http(this.url(operation), {
      method: 'POST',
      headers: { username: this.credential('username'), password: this.credential('password') },
      json: { app_key: this.credential('appKey'), app_secret: this.credential('appSecret'), ...extra },
    });
    const data = response.data;
    const problem = this.problem(response, data);

    if (problem !== null || !field(data, 'id_token')) {
      throw new GatewayError(
        `bKash token ${operation} failed: ${problem ? describe(problem) : 'no id_token in the response'}`,
        this.name,
        data,
      );
    }

    return data;
  }

  /**
   * Refuse a third grant/refresh within an hour rather than get the merchant
   * blocked for one. Treated as "unavailable": payments stay pending.
   */
  private async countTokenCall(): Promise<void> {
    const key = await this.tokenCacheKey(this.tokenKey('calls'));
    const now = Math.floor(Date.now() / 1000);
    const stored = await this.ctx.cache.get<unknown>(key);
    const calls = (Array.isArray(stored) ? stored : []).filter(
      (at): at is number => typeof at === 'number' && at > now - 3600,
    );

    if (calls.length >= BkashGateway.TOKEN_CALLS_PER_HOUR) {
      const retryAt = new Date((Math.min(...calls) + 3600) * 1000).toISOString();

      throw new GatewayUnavailableError(
        `bKash allows ${BkashGateway.TOKEN_CALLS_PER_HOUR} token calls per hour and a third blocks the merchant for an hour. Not calling again before ${retryAt}.`,
        this.name,
      );
    }

    await this.ctx.cache.set(key, [...calls, now], 3600);
  }

  private tokenKey(kind: string): string {
    return `${kind}:${this.version}:${this.option('appKey')}`;
  }

  private get paymentIdKey(): string {
    return this.legacy ? 'paymentID' : 'paymentId';
  }

  /**
   * The error in a response, in either version's shape: V2 errors carry
   * externalCode/errorMessageEn and successes have no statusCode; v1.2.0-beta
   * successes have statusCode "0000" and errors statusCode/statusMessage or
   * errorCode/errorMessage.
   */
  private problem(response: HttpResponse, data: JsonObject): Problem | null {
    let code = field(data, 'externalCode', 'errorCode');
    const statusCode = field(data, 'statusCode');

    if (code === null && statusCode !== null && statusCode !== '0000') {
      code = statusCode;
    }

    if (code === null && !response.ok) {
      code = `HTTP ${response.status}`;
    }

    if (code === null) {
      return null;
    }

    return {
      code,
      message:
        field(data, 'errorMessageEn', 'errorMessage', 'statusMessage', 'message', 'Message') ?? 'no message',
    };
  }
}

function describe(problem: Problem): string {
  return limit(`${problem.code}: ${problem.message}`, 255);
}

/** bKash rejects <, > and & in references, and anything over 255 characters. */
function clean(value: string): string {
  return limit(value.replace(/[<>&]/g, '').trim(), 255);
}
