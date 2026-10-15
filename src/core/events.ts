import type { Payment, RefundResult } from './types.js';

export interface BdPayGateEvents {
  /** Confirmed with the gateway's API, amount matched. Fires once per payment: fulfil the order here. */
  'payment.completed': { payment: Payment };
  'payment.failed': { payment: Payment };
  'payment.cancelled': { payment: Payment };
  /** A second attempt for a reference that was already paid was also paid. Refund one of them. */
  'payment.duplicated': { payment: Payment };
  'refund.processed': { payment: Payment; refund: RefundResult };
}

export type EventName = keyof BdPayGateEvents;
export type Listener<E extends EventName> = (event: BdPayGateEvents[E]) => void | Promise<void>;

/**
 * Listeners run in order and are awaited. A listener that throws makes the
 * callback answer with an error (so the gateway retries its IPN), but the
 * payment's state has already been saved and the event will not fire again:
 * make listeners idempotent or queue the work.
 */
export class Emitter {
  private readonly listeners = new Map<EventName, Set<Listener<EventName>>>();

  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<EventName>);
    this.listeners.set(event, set);

    return () => this.off(event, listener);
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    this.listeners.get(event)?.delete(listener as Listener<EventName>);
  }

  async emit<E extends EventName>(event: E, payload: BdPayGateEvents[E]): Promise<void> {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      await listener(payload);
    }
  }
}
