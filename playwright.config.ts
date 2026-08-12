import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';
import * as fs from 'fs';

/**
 * See https://playwright.dev/docs/test-configuration.
 */

/**
 * Queue mode (scripts/queueRunner.ts) sets PT_QUEUE_MAP_FILE to a JSON file of
 * automationId -> instanceId for the tests it resolved. Building the `grep`
 * RegExp here, in-process at config-load time, rather than passing it as a
 * `--grep` CLI argument, avoids OS command-line length limits entirely - this
 * scales to any number of tests, whereas a CLI arg could eventually hit e.g.
 * Windows' ~32K character command-line limit with enough automation IDs.
 * Returns undefined (no filtering) outside queue mode.
 */
function queueGrep(): RegExp | undefined {
  const mapFilePath = process.env.PT_QUEUE_MAP_FILE;
  if (!mapFilePath) return undefined;

  const map = JSON.parse(fs.readFileSync(mapFilePath, 'utf8'));
  const automationIds = Object.keys(map).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`@pt-(${automationIds.join('|')})`);
}

export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Queue mode (scripts/queueRunner.ts) only: filters to the mapped tests. */
  grep: queueGrep(),
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['junit', { outputFile: 'test-results/playwright-results.xml' }],
    ['html'],
    ['./practitestReporter']
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
