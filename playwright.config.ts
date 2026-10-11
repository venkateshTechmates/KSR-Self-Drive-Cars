// End-to-end tests: the built app on a fresh database with demo data (e2e/start-server.ts).
// Run `npm run test:e2e` (builds first) or `npx playwright test` after `npm run build`.
// Uses the installed Google Chrome; set PW_CHANNEL=chromium after `npx playwright install chromium`.
import { defineConfig, devices } from '@playwright/test';
import { E2E } from './e2e/env.ts';

const channel = process.env.PW_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: './e2e',
  outputDir: './node_modules/.tmp/e2e-results',
  // Specs share one database and change bookings, so run them one at a time in a set order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: './node_modules/.tmp/e2e-report', open: 'never' }]],
  use: {
    baseURL: E2E.baseURL,
    channel,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'], channel } },
    {
      name: 'desktop',
      testMatch: /.*\.spec\.ts/,
      testIgnore: /mobile\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], channel, viewport: { width: 1280, height: 900 } },
    },
    {
      // Phone-sized checks of the public site and the admin's mobile layout (read-only).
      name: 'mobile',
      testMatch: /mobile\.spec\.ts/,
      dependencies: ['desktop'],
      use: { ...devices['Pixel 7'], channel },
    },
  ],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning e2e/start-server.ts',
    url: `${E2E.baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
  },
});
