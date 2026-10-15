import { createServer, type Server } from 'node:http';
import bodyParser from '@koa/bodyparser';
import express from 'express';
import Fastify from 'fastify';
import Koa from 'koa';
import { afterEach, describe, expect, it } from 'vitest';
import { bdpaygate as expressAdapter } from '../../src/adapters/express.js';
import { bdpaygate as fastifyAdapter } from '../../src/adapters/fastify.js';
import { bdpaygate as koaAdapter } from '../../src/adapters/koa.js';
import { bdpaygateMiddleware } from '../../src/adapters/nestjs.js';
import { nodeHandler } from '../../src/adapters/node.js';
import type { BdPayGate } from '../../src/index.js';
import { charge, form, json, listen, makePay, pathOf } from './helpers.js';

type Boot = (pay: BdPayGate) => Promise<{ url: string; close: () => Promise<void> }>;

const closeServer = (server: Server) => () => new Promise<void>((resolve) => server.close(() => resolve()));

const frameworks: [string, Boot][] = [
  [
    'node:http',
    async (pay) => {
      const server = createServer(nodeHandler(pay));

      return { url: await listen(server), close: closeServer(server) };
    },
  ],
  [
    'express (no body parser)',
    async (pay) => {
      const app = express();
      app.use(expressAdapter(pay));
      app.get('/other', (_req, res) => {
        res.send('other');
      });
      const server = createServer(app);

      return { url: await listen(server), close: closeServer(server) };
    },
  ],
  [
    'express (with json + urlencoded parsers)',
    async (pay) => {
      const app = express();
      app.use(express.json(), express.urlencoded({ extended: true }));
      app.use(expressAdapter(pay));
      app.get('/other', (_req, res) => {
        res.send('other');
      });
      const server = createServer(app);

      return { url: await listen(server), close: closeServer(server) };
    },
  ],
  [
    'nestjs-style middleware',
    async (pay) => {
      const app = express();
      app.use(express.json(), express.urlencoded({ extended: true }));
      app.use(bdpaygateMiddleware(pay));
      app.get('/other', (_req, res) => {
        res.send('other');
      });
      const server = createServer(app);

      return { url: await listen(server), close: closeServer(server) };
    },
  ],
  [
    'fastify',
    async (pay) => {
      const app = Fastify();
      await app.register(fastifyAdapter, { pay });
      app.get('/other', async () => 'other');
      const url = await app.listen({ port: 0, host: '127.0.0.1' });

      return { url, close: () => app.close() };
    },
  ],
  [
    'koa (no body parser)',
    async (pay) => {
      const app = new Koa();
      app.use(koaAdapter(pay));
      app.use(async (ctx) => {
        if (ctx.path === '/other') ctx.body = 'other';
      });
      const server = createServer(app.callback());

      return { url: await listen(server), close: closeServer(server) };
    },
  ],
  [
    'koa (with bodyparser)',
    async (pay) => {
      const app = new Koa();
      app.use(bodyParser());
      app.use(koaAdapter(pay));
      app.use(async (ctx) => {
        if (ctx.path === '/other') ctx.body = 'other';
      });
      const server = createServer(app.callback());

      return { url: await listen(server), close: closeServer(server) };
    },
  ],
];

describe.each(frameworks)('%s adapter', (_name, boot) => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start() {
    const pay = makePay();
    const server = await boot(pay);
    close = server.close;

    return { pay, url: server.url };
  }

  it('completes a payment from the GET return and redirects to the success page', async () => {
    const { pay, url } = await start();
    const payment = await charge(pay);

    const response = await fetch(url + pathOf(payment.checkoutUrl), { redirect: 'manual' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/paid?payment=${payment.id}`);
    expect((await pay.find(payment.id))?.status).toBe('completed');
  });

  it('accepts a form POST (cross-site return) and answers an IPN with JSON', async () => {
    const { pay, url } = await start();
    const payment = await charge(pay);

    const cancel = await fetch(`${url}/bdpaygate/fake/cancel`, form({ ref: payment.gatewayReference }));
    expect(cancel.status).toBe(303);
    expect(cancel.headers.get('location')).toBe(`/cancelled?payment=${payment.id}`);

    const ipn = await fetch(`${url}/bdpaygate/fake/ipn`, form({ ref: payment.gatewayReference }));
    expect(ipn.status).toBe(200);
    expect(await ipn.json()).toEqual({ ok: true, status: 'completed' });
  });

  it('accepts a JSON POST', async () => {
    const { pay, url } = await start();
    const payment = await charge(pay);

    const ipn = await fetch(`${url}/bdpaygate/fake/ipn`, json({ ref: payment.gatewayReference }));

    expect(ipn.status).toBe(200);
    expect((await pay.find(payment.id))?.status).toBe('completed');
  });

  it('rejects an unknown payment and a malformed parameter without a 5xx', async () => {
    const { pay, url } = await start();
    const payment = await charge(pay);

    const unknown = await fetch(`${url}/bdpaygate/fake/ipn`, form({ ref: 'NOPE' }));
    expect(unknown.status).toBe(400);

    const malformed = await fetch(`${url}/bdpaygate/fake/success?ref[]=${payment.gatewayReference}`, {
      redirect: 'manual',
    });
    expect(malformed.status).toBe(303);
    expect(malformed.headers.get('location')).toBe('/failed');
    expect((await pay.find(payment.id))?.status).toBe('pending');
  });

  it('404s an unknown gateway and leaves other routes alone', async () => {
    const { url } = await start();

    expect((await fetch(`${url}/bdpaygate/nope/success`)).status).toBe(404);

    if (!_name.startsWith('node:http')) {
      const other = await fetch(`${url}/other`);
      expect(await other.text()).toBe('other');
    }
  });
});
