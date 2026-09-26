import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the **built** artifact, not the dev server.
 *
 * The two are not the same program. The dev server serves modules unbundled, transforms
 * workers on the fly, and never runs the service-worker build; anything about chunk
 * splitting, lazy loading or precaching simply does not exist there to be tested. A
 * worker format that silently inlines every lazy import — which is what this project
 * shipped until it was caught — passes the dev suite and fails in production.
 *
 * Run with `pnpm test:e2e:prod`. Kept out of the default `test:e2e` because it rebuilds
 * the app and downloads the fallback core, which is a slow thing to put in front of every
 * change.
 */
export default defineConfig({
  testDir: './tests/e2e-prod',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 180_000,

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // Builds first, so the tests always describe the artifact as it would be deployed.
    command: 'pnpm build && node scripts/serve-deploy.mjs --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
