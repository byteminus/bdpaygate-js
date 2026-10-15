// Runs the built package on whatever runtime executes this file (Node, Bun, Deno):
// charge with the fake gateway, follow the checkout URL through the Web handler,
// and check the payment completed and the event fired once.
import { createBdPayGate } from '../dist/index.js';

const pay = createBdPayGate({
  baseUrl: 'https://shop.test',
  gateways: { fake: {} },
  redirects: { success: '/paid' },
  logger: { warn() {} },
});
let completed = 0;
pay.on('payment.completed', () => {
  completed++;
});

const payment = await pay.charge({
  amount: 250,
  reference: 'SMOKE-1',
  customer: { name: 'Smoke', phone: '01711000000' },
});
const response = await pay.fetch(new Request(payment.checkoutUrl));
await pay.fetch(new Request(payment.checkoutUrl));
const stored = await pay.find(payment.id);

if (response.status !== 303 || stored?.status !== 'completed' || completed !== 1) {
  console.error('smoke test failed', { status: response.status, stored: stored?.status, completed });
  process.exit(1);
}

const runtime = globalThis.Bun
  ? `Bun ${Bun.version}`
  : globalThis.Deno
    ? `Deno ${Deno.version.deno}`
    : `Node ${process.version}`;
console.log(`ok: ${runtime}`);
