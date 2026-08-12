import { test, expect } from '@playwright/test';

// 50 lightweight tests for the queue-mode regression demo (npm run queue:run).
// Each corresponds to a PractiTest Test whose "Automation ID" field matches
// this test's `@pt-regression-NNN` tag - see README's "Queue-based demo"
// section for how the mapping works.
//
// FAILING holds fixed indexes so the same tests fail on every demo run,
// rather than random failures that would make the demo unrepeatable.
const TOTAL = 50;
const FAILING = new Set([7, 23, 41]);

for (let i = 1; i <= TOTAL; i++) {
  const id = `regression-${String(i).padStart(3, '0')}`;

  test(`Regression check ${id}`, { tag: `@pt-${id}` }, async ({ page }) => {
    await page.goto('https://example.com');
    if (FAILING.has(i)) {
      await expect(page.getByText('This text does not exist')).toBeVisible();
    } else {
      await expect(page.getByText('Example Domain')).toBeVisible();
    }
  });
}
