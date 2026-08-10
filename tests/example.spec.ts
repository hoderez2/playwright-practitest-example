import { test, expect } from '@playwright/test';

test.describe('PractiTest Demo', () => {
  test('Homepage loads', { tag: '@pt-home-loads' }, async ({ page }) => {
    await page.goto('https://example.com');
    await expect(page.getByText('Example Domain')).toBeVisible();
  });

  test('Intentional failure', { tag: '@pt-intentional-failure' }, async ({ page }) => {
    await page.goto('https://example.com');
    await expect(page.getByText('Something that does not exist')).toBeVisible();
  });
})
test.describe('User Authentication', () => {
  test('Page is publicly accessible without login', { tag: '@pt-public-access' }, async ({ page }) => {
    const response = await page.goto('https://example.com');
    expect(response?.status()).toBe(200);
  });
  test('Password Field Security', { tag: '@pt-password-security' }, async ({ page }) => {
    const response = await page.goto('https://example.com');
    expect(response?.status()).toBe(200);
  });
});
