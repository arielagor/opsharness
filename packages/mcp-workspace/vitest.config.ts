import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    env: { OPSHARNESS_LOG_LEVEL: 'warn' },
  },
})
