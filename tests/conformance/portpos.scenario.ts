import type { GatewayConfig, JsonObject, Payment } from '../../src/index.js';
import { type MockRequest, type Routes, reply } from '../support/mock-fetch.js';
import { type CallbackSpec, GatewayScenario, get, post } from '../support/scenario.js';

/** A path segment of a stubbed request, counted from the end when negative. */
export function segment(request: MockRequest, index: number): string {
  return decodeURIComponent(request.url.pathname.split('/').at(index) ?? '');
}

export default class PortPosScenario extends GatewayScenario {
  readonly gateway = 'portpos';

  config(): GatewayConfig {
    return {
      driver: 'portpos',
      appKey: 'pp-app-key',
      secretKey: 'pp-secret-key',
      sandbox: true,
    };
  }

  routes(): Routes {
    return {
      // Order matters: the first matching pattern wins.
      'api-sandbox.portpos.com/payment/v2/invoice/ipn/*': this.verification(async (request) => {
        const payment = await this.payment('gatewayPaymentId', segment(request, -2));

        return reply(
          this.invoice(
            payment,
            this.state === 'paid' ? 'ACCEPTED' : this.state === 'failed' ? 'CANCELLED' : 'PENDING',
          ),
        );
      }),

      'api-sandbox.portpos.com/payment/v2/invoice/refund/*': (request) => {
        const refund = request.data.refund;
        const amount =
          refund !== null && typeof refund === 'object' && 'amount' in refund ? Number(refund.amount) : 0;

        return reply(
          {
            data: {
              order: {
                invoice: segment(request, -1),
                amount: '150.00',
                currency: 'BDT',
                status: 'REFUND_PENDING',
              },
              refund: { amount, status: 'APPROVED' },
            },
            result: 'SUCCESS',
          },
          202,
        );
      },

      'api-sandbox.portpos.com/payment/v2/invoice': (request) => this.created(request.data),
    };
  }

  /** The create invoice answer for a request. */
  created(data: JsonObject): Response {
    const order = data.order !== null && typeof data.order === 'object' ? (data.order as JsonObject) : {};
    const reference = String(order.reference);

    return reply(
      {
        result: 'success',
        data: {
          invoice_id: `PP${reference}`,
          reference,
          order: { amount: order.amount, currency: 'BDT', status: 'PENDING' },
          action: {
            type: 'redirect',
            url: `https://ppv2.portpos.com/v2/invoice/PP${reference}`,
            payload: null,
            method: 'GET',
          },
        },
      },
      201,
    );
  }

  /**
   * The customer's return: PortPos's own query parameters are undocumented,
   * and the driver only needs the ?ref= it registered.
   */
  successCallback(payment: Payment): CallbackSpec {
    return get('/bdpaygate/portpos/callback', { ref: payment.gatewayReference });
  }

  /** PortPos posts the IPN on failure too. */
  override failureCallback(payment: Payment): CallbackSpec {
    return post(`/bdpaygate/portpos/ipn?ref=${payment.gatewayReference}`, {
      invoice: payment.gatewayPaymentId,
      amount: payment.amount,
      status: 'CANCELLED',
      reference: payment.gatewayReference,
    });
  }

  invoice(payment: Payment, status: string): JsonObject {
    return {
      result: 'success',
      data: {
        invoice_id: payment.gatewayPaymentId,
        reference: payment.gatewayReference,
        order: {
          amount: this.reported(payment),
          currency: 'BDT',
          type: 'purchase',
          status,
        },
        billing: {
          gateway: {
            category: 'card',
            network: 'visa',
            status: 'APPROVED',
            approve_code: `AC${payment.gatewayReference.slice(2, 10)}`,
          },
        },
        transactions: [{ amount: this.reported(payment), currency: 'BDT', status, type: 'purchase' }],
      },
    };
  }
}
