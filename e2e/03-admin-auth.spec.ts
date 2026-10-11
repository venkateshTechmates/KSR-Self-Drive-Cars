// Admin sign-in (ADM-02, ADM-03): no access without a session, wrong passwords and codes,
// two-step verification for Managers, and sign-out.
import { expect, test } from '@playwright/test';
import { E2E } from './env.ts';
import { enterCode, signIn, totp } from './helpers.ts';

test('admin pages send visitors to the sign-in page', async ({ page }) => {
  await page.goto('/admin/bookings');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Forgot your password?' })).toBeVisible();
});

test('a wrong password is refused without saying which part was wrong', async ({ page }) => {
  await signIn(page, E2E.staff.email, 'not-the-password');
  await expect(page.getByText('Email or password is not right.')).toBeVisible();
  await signIn(page, 'nobody@ksr.test', 'not-the-password');
  await expect(page.getByText('Email or password is not right.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('a Manager needs the authenticator code; a wrong code is refused', async ({ page }) => {
  await signIn(page, E2E.manager.email);
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();

  // Until the code is entered, admin pages stay closed.
  await page.goto('/admin/bookings');
  await expect(page).toHaveURL(/\/admin\/mfa$/);

  await enterCode(page, '000000');
  await expect(page.getByText('That code is not right, or it expired. Try the current code.')).toBeVisible();
  await enterCode(page, totp(E2E.managerTotpSecret));
  await expect(page).toHaveURL(/\/admin\/bookings$/);
  await expect(page.getByRole('heading', { name: 'Bookings', level: 1 })).toBeVisible();
});

test('Staff sign in with a password and can sign out', async ({ page }) => {
  await signIn(page, E2E.staff.email);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('forgot password always gives the same answer', async ({ page }) => {
  await page.goto('/admin/reset-password');
  await page.getByLabel('Email').fill('nobody@ksr.test');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('If that email has an admin account, we sent a link to reset the password. Check your inbox.')).toBeVisible();
});
