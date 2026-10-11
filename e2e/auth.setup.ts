// Signs in the three demo roles once and saves their browser state for the specs.
// The Owner sets up two-step verification here (first sign-in); the Manager is already
// enrolled; Staff accounts don't need two-step verification.
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import { E2E } from './env.ts';
import { authFile, enterCode, ownerSecretFile, signIn, totp } from './helpers.ts';

setup.beforeAll(() => mkdirSync(E2E.authDir, { recursive: true }));

setup('Owner: first sign-in sets up two-step verification', async ({ page }) => {
  await signIn(page, E2E.owner.email);
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await page.locator('code').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  writeFileSync(ownerSecretFile(), secret);

  await enterCode(page, totp(secret));
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.context().storageState({ path: authFile('owner') });
});

setup('Manager: signs in with an authenticator code', async ({ page }) => {
  await signIn(page, E2E.manager.email);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await enterCode(page, totp(E2E.managerTotpSecret));
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.context().storageState({ path: authFile('manager') });
});

setup('Staff: signs in with a password only', async ({ page }) => {
  await signIn(page, E2E.staff.email);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.context().storageState({ path: authFile('staff') });
});
