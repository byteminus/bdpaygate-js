# Contributing

Thanks for helping. Bug reports with a failing test are the most useful thing you can send.

## Setup

Developing needs Node.js 22.18 or newer (the build tool requires it). The published package runs on Node.js 20.19+, Bun and Deno, and CI tests it on all of them.

```bash
git clone https://github.com/byteminus/bdpaygate-js.git
cd bdpaygate-js
npm install
npm test
```

| Command | What it does |
|---|---|
| `npm test` | Vitest: conformance suite, driver tests, adapters, stores |
| `npm run typecheck` | `tsc --noEmit` in strict mode |
| `npm run lint` / `npm run format` | Biome |
| `npm run build` | ESM + CJS + types with tsdown |
| `npm run check:package` | publint and arethetypeswrong on the packed tarball |

Run one gateway's conformance tests with `CONFORMANCE=bkash,nagad npx vitest run tests/conformance.test.ts`.

## Adding or changing a gateway

1. The driver lives in `src/drivers/<name>.ts` and extends `AbstractGateway`.
2. Add `tests/conformance/<name>.scenario.ts`: it teaches the shared conformance suite how the gateway answers. A gateway is supported when it passes every conformance test.
3. Put gateway-specific behaviour in `tests/drivers/<name>.test.ts`.
4. Never trust callback data: find the payment by its id, then confirm with the gateway's API and `assertAmountMatches()` before calling `transition()`.
5. A timeout must leave the payment pending (`GatewayUnavailableError`), never failed.

Keep the Laravel package (`byteminus/laravel-bdpaygate`) in step: behaviour changes should land in both.

## Pull requests

- One topic per pull request, with tests.
- `npm run lint && npm run typecheck && npm test` must pass.
- Add a line to `CHANGELOG.md`.
