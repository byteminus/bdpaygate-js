import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    // The conformance suite discovers scenario files with import.meta.glob; a
    // persisted module cache would hide newly added ones.
    fsModuleCache: false,
  },
});
