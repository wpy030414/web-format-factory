import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Deliberately separate from vite.config.ts: the PWA plugin has no business running
 * during unit tests, and keeping the two configs apart keeps test startup fast.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // unit: pure logic. integration: real engines writing real artifacts, with the
    // output handed to ffprobe to verify it — see tests/integration/engine.test.ts.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
