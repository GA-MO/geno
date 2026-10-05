import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Engine e2e tests open the sandbox, which allows one per process; a test abandoned at a short timeout
    // under machine load leaves it open and fails every later test in the file.
    testTimeout: 30_000,
  },
});
