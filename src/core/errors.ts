import type { JsonObject } from './types.js';

/** Base class of every error this package throws. */
export class BdPayGateError extends Error {
  override name = 'BdPayGateError';

  constructor(
    message: string,
    /** The gateway name, when the error came from one. */
    readonly gateway: string | null = null,
    /** What the gateway answered, if anything. */
    readonly response: JsonObject | null = null,
  ) {
    super(message);
  }
}

/** The gateway refused the request, or the package refused to proceed. */
export class GatewayError extends BdPayGateError {
  override name = 'GatewayError';
}

/**
 * The gateway did not answer (timeout, dropped connection). Nothing was
 * decided: the payment stays pending and a later sync settles it.
 */
export class GatewayUnavailableError extends GatewayError {
  override name = 'GatewayUnavailableError';
}

/** A callback that could not be verified: forged, replayed for another payment, or about an unknown one. */
export class InvalidCallbackError extends GatewayError {
  override name = 'InvalidCallbackError';
}

/** A callback whose parameters have the wrong shape, e.g. ?invoice_id[]=x. */
export class MalformedCallbackError extends InvalidCallbackError {
  override name = 'MalformedCallbackError';
}

/** The gateway has no API for this (e.g. refunds that only the merchant panel can do). */
export class UnsupportedOperationError extends GatewayError {
  override name = 'UnsupportedOperationError';
}

/** Configuration is missing or wrong. */
export class ConfigurationError extends BdPayGateError {
  override name = 'ConfigurationError';
}
