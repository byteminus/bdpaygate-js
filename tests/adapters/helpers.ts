import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type BdPayGate, createBdPayGate, type Payment } from '../../src/index.js';

export function makePay(prefix?: string): BdPayGate {
  const pay = createBdPayGate({
    baseUrl: 'https://shop.test',
    prefix,
    gateways: { fake: { driver: 'fake' } },
    redirects: { success: '/paid', failed: '/failed', cancelled: '/cancelled', pending: '/pending' },
    logger: { warn() {} },
  });
  pay.fake();

  return pay;
}

export async function charge(pay: BdPayGate, reference = 'ORD-1'): Promise<Payment> {
  return pay.charge({ amount: 500, reference, customer: { name: 'Karim', phone: '01711000000' } });
}

/** The checkout URL's path and query, to send to a local server. */
export function pathOf(url: string | null): string {
  const parsed = new URL(url ?? '');

  return parsed.pathname + parsed.search;
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export const form = (data: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(data).toString(),
  redirect: 'manual' as const,
});

export const json = (data: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
  redirect: 'manual' as const,
});
