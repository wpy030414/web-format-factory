import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the real dev server, because the things worth testing
 * here only exist in a browser: Web Workers, drag-and-drop, and the download flow.
 *
 * The dev server is started with the same COOP/COEP headers production must send, so
 * cross-origin isolation is exercised rather than assumed.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'pnpm dev --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
