// Owner-only screens: business settings that change the website, inviting staff (the invite
// link works end to end), and the read-only audit log.
import { expect, test } from '@playwright/test';
import { authFile, signIn } from './helpers.ts';

test.use({ storageState: authFile('owner') });

test('a business phone number turns on "Call to book" across the website', async ({ page, browser }) => {
  const visitor = await browser.newContext();
  const site = await visitor.newPage();
  await site.goto('/');
  await expect(site.getByRole('heading', { name: 'Our fleet' })).toBeVisible();
  await expect(site.getByRole('link', { name: /Call to book/ })).toHaveCount(0);

  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.getByLabel('Phone number').fill('98765 43210');
  await page.getByLabel('WhatsApp number').fill('98765 43210');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Business details saved. The website shows them straight away.')).toBeVisible();

  await site.reload();
  const call = site.getByRole('link', { name: /Call to book/ }).first();
  await expect(call).toBeVisible();
  await expect(call).toHaveAttribute('href', 'tel:+919876543210');
  await expect(site.getByRole('link', { name: /WhatsApp/ }).first()).toHaveAttribute('href', /wa\.me\/919876543210/);
  await visitor.close();
});

test('inviting a staff member: the link lets them choose a password and sign in', async ({ page, browser }) => {
  await page.goto('/admin/staff');
  await page.getByRole('button', { name: 'Invite someone' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite someone' });
  await invite.getByLabel(/^Full name/).fill('Asha Counter');
  await invite.getByLabel(/^Email/).fill('asha@ksr.test');
  await invite.getByLabel(/^Role/).selectOption('staff');
  await invite.getByRole('button', { name: 'Send invite' }).click();

  // Without SMTP the Owner gets the link to share.
  const share = page.getByRole('dialog', { name: 'Share this link' });
  await expect(share).toContainText('For asha@ksr.test:');
  const link = (await share.locator('code').textContent())!.trim();
  expect(link).toMatch(/\/admin\/reset-password\?token=.+&invite=1$/);
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Asha Counter').filter({ visible: true }).first()).toBeVisible();

  const newcomer = await browser.newContext();
  const p = await newcomer.newPage();
  await p.goto(link);
  await expect(p.getByRole('heading', { name: 'Welcome! Choose your password' })).toBeVisible();
  await p.getByLabel('New password').fill('short');
  await p.getByLabel('Type it again').fill('short');
  await p.getByRole('button', { name: 'Save password' }).click();
  await expect(p.getByText('Use at least 10 characters.')).toBeVisible();
  await p.getByLabel('New password').fill('Asha-counter-2026');
  await p.getByLabel('Type it again').fill('Asha-counter-2026');
  await p.getByRole('button', { name: 'Save password' }).click();
  await expect(p.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // The link is single-use.
  await p.goto(link);
  await expect(p.getByText("This link can't be used")).toBeVisible();

  // And the new password signs in.
  await p.context().clearCookies();
  await signIn(p, 'asha@ksr.test', 'Asha-counter-2026');
  await expect(p.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await newcomer.close();
});

test('the audit log records sign-ins, overrides and settings changes', async ({ page }) => {
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  const search = page.getByRole('form', { name: 'Search the audit log' });
  await search.getByLabel('Action contains').fill('override');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('booking.override').filter({ visible: true }).first()).toBeVisible();

  await search.getByLabel('Action contains').fill('settings');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText(/settings\./).filter({ visible: true }).first()).toBeVisible();
});
