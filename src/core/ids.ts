const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomFrom(alphabet: string, length: number): string {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = '';

  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) {
        out += alphabet[byte % alphabet.length];
      }
    }
  }

  return out;
}

/** A ULID: sortable by creation time, 26 characters. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let ms = now;

  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }

  return time + randomFrom(CROCKFORD, 16);
}

/**
 * A fresh id for each attempt. Gateways reject or mishandle a reused one
 * (Nagad, Upay, aamarPay, SSLCommerz), and old checkout pages stay payable,
 * so a retry must never reuse the previous attempt's id. 20 uppercase
 * alphanumerics fits every gateway's limits.
 */
export function newGatewayReference(): string {
  return `BP${randomFrom(ALPHANUMERIC, 18)}`;
}

export function randomString(length: number): string {
  return randomFrom(ALPHANUMERIC, length);
}
