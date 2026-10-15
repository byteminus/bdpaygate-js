import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/adapters/*.ts', 'src/stores/*.ts', 'src/cache/*.ts'],
  format: ['esm', 'cjs'],
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  unbundle: false,
  external: [/^node:/],
});
