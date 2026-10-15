import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { routeHandler as adonis } from '../../src/adapters/adonis.js';
import { endpoints as astro } from '../../src/adapters/astro.js';
import { bdpaygate as honoAdapter } from '../../src/adapters/hono.js';
import { routeHandlers as next } from '../../src/adapters/next.js';
import { eventHandler as nuxt } from '../../src/adapters/nuxt.js';
import { routeModule as reactRouter } from '../../src/adapters/react-router.js';
import { requestHandlers as sveltekit } from '../../src/adapters/sveltekit.js';
import { webHandler } from '../../src/adapters/web.js';
import type { BdPayGate, Payment } from '../../src/index.js';
import { charge, makePay } from './helpers.js';

type Call = (
  pay: BdPayGate,
  request: Request,
  params: { gateway: string; outcome: string },
) => Promise<Response>;

const adapters: [string, Call][] = [
  ['web (Bun, Deno, Workers)', (pay, request) => webHandler(pay)(request)],
  ['pay.fetch', (pay, request) => pay.fetch(request)],
  [
    'hono',
    (pay, request) => {
      const app = new Hono();
      app.all('/bdpaygate/:gateway/:outcome', honoAdapter(pay));

      return Promise.resolve(app.request(request));
    },
  ],
  [
    'next (App Router, params as a Promise)',
    (pay, request, params) =>
      next(pay)[request.method === 'GET' ? 'GET' : 'POST'](request, { params: Promise.resolve(params) }),
  ],
  ['next (App Router, plain params)', (pay, request, params) => next(pay).POST(request, { params })],
  ['sveltekit', (pay, request, params) => sveltekit(pay).POST({ request, params })],
  [
    'react-router / remix',
    (pay, request, params) =>
      reactRouter(pay)[request.method === 'GET' ? 'loader' : 'action']({ request, params }),
  ],
  ['astro', (pay, request, params) => astro(pay).POST({ request, params })],
  ['nuxt (h3 v2)', (pay, request, params) => nuxt(pay)({ req: request, context: { params } })],
  [
    'nuxt (h3 v1, node req)',
    async (pay, request, params) => {
      const body = request.method === 'GET' ? [] : [await request.text()];
      const req = Object.assign(Readable.from(body), {
        method: request.method,
        url: new URL(request.url).pathname + new URL(request.url).search,
        headers: Object.fromEntries(request.headers),
      });

      return nuxt(pay)({ node: { req }, context: { params } });
    },
  ],
  [
    'adonis',
    async (pay, request, params) => {
      const url = new URL(request.url);
      const text = request.method === 'GET' ? '' : await request.text();
      const body = request.headers.get('content-type')?.includes('json')
        ? JSON.parse(text)
        : Object.fromEntries(new URLSearchParams(text));
      let status = 200;
      const headers = new Headers();
      let sent: unknown = '';
      await adonis(pay)({
        params,
        request: {
          method: () => request.method,
          qs: () => Object.fromEntries(url.searchParams),
          body: () => body,
          headers: () => Object.fromEntries(request.headers),
          raw: () => text,
        },
        response: {
          status: (code) => {
            status = code;
          },
          header: (k, v) => headers.set(k, v),
          send: (b) => {
            sent = b;
          },
        },
      });

      return new Response(status === 303 ? null : String(sent), { status, headers });
    },
  ],
];

function request(
  method: 'GET' | 'POST',
  path: string,
  payment: Payment,
  type: 'form' | 'json' = 'form',
): Request {
  const url = new URL(path, 'https://shop.test');

  if (method === 'GET') {
    url.searchParams.set('ref', payment.gatewayReference);

    return new Request(url);
  }

  return new Request(url, {
    method,
    headers: { 'content-type': type === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' },
    body:
      type === 'json' ? JSON.stringify({ ref: payment.gatewayReference }) : `ref=${payment.gatewayReference}`,
  });
}

describe.each(adapters)('%s adapter', (_name, call) => {
  it('completes from a GET return and redirects to success', async () => {
    const pay = makePay();
    const payment = await charge(pay);

    const response = await call(pay, request('GET', '/bdpaygate/fake/success', payment), {
      gateway: 'fake',
      outcome: 'success',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);
    expect((await pay.find(payment.id))?.status).toBe('completed');
  });

  it('handles a form POST cancel and a JSON IPN', async () => {
    const pay = makePay();
    const payment = await charge(pay);

    const cancel = await call(pay, request('POST', '/bdpaygate/fake/cancel', payment), {
      gateway: 'fake',
      outcome: 'cancel',
    });
    expect(cancel.headers.get('location')).toBe(`/cancelled?payment=${payment.id}`);

    const ipn = await call(pay, request('POST', '/bdpaygate/fake/ipn', payment, 'json'), {
      gateway: 'fake',
      outcome: 'ipn',
    });
    expect(ipn.status).toBe(200);
    expect((await pay.find(payment.id))?.status).toBe('completed');
  });

  it('404s an unknown gateway or outcome', async () => {
    const pay = makePay();
    const payment = await charge(pay);

    const response = await call(pay, request('POST', '/bdpaygate/nope/ipn', payment), {
      gateway: 'nope',
      outcome: 'ipn',
    });
    const outcome = await call(pay, request('POST', '/bdpaygate/fake/hack', payment), {
      gateway: 'fake',
      outcome: 'hack',
    });

    expect(response.status).toBe(404);
    expect(outcome.status).toBe(404);
  });
});
