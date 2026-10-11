// Staff see only what they need today (PRD 2.2): bookings from yesterday to tomorrow and cars
// out now, no fleet, customers, payments or settings, and no Owner/Manager actions.
import { expect, test } from '@playwright/test';
import { authFile, card, demo } from './helpers.ts';

test.use({ storageState: authFile('staff') });

test('the dashboard has Today and Overdue only', async ({ page }) => {
  await page.goto('/admin');
  await expect(card(page, 'Today')).toBeVisible();
  await expect(card(page, 'Overdue').getByText(demo().bookings.overdue.code)).toBeVisible();
  await expect(card(page, 'Needs action')).toHaveCount(0);
  await expect(card(page, 'This month')).toHaveCount(0);
});

test('the menu hides Owner and Manager screens, and their URLs are closed', async ({ page }) => {
  await page.goto('/admin');
  const nav = page.getByRole('navigation', { name: 'Admin' }).filter({ visible: true });
  await expect(nav.getByRole('link', { name: 'Bookings' })).toBeVisible();
  for (const name of ['Fleet', 'Customers', 'Payments', 'Settings', 'Staff', 'Audit log']) {
    await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  for (const path of ['/admin/fleet', '/admin/customers', '/admin/settings', '/admin/bookings/new']) {
    await page.goto(path);
    await expect(page.getByText('Not available for your role')).toBeVisible();
  }
});

test('the bookings list covers yesterday to tomorrow and cars out now', async ({ page }) => {
  const b = demo().bookings;
  await page.goto('/admin/bookings');
  await expect(page.getByText('You can see bookings from yesterday to tomorrow, and cars that are out now.')).toBeVisible();
  await page.getByRole('group', { name: 'Which bookings' }).getByRole('button', { name: 'All', exact: true }).click();
  for (const key of ['requested', 'pickupToday', 'active', 'overdue'] as const) {
    await expect(page.getByText(b[key].code).filter({ visible: true }).first()).toBeVisible();
  }
  for (const key of ['clashConfirmed', 'closed', 'toReject'] as const) {
    await expect(page.getByText(b[key].code).filter({ visible: true })).toHaveCount(0);
  }
});

test('a booking outside the window cannot be opened', async ({ page }) => {
  const { code } = demo().bookings.closed;
  await page.goto(`/admin/bookings/${code}`);
  await expect(page.getByText(`Booking ${code} not found`)).toBeVisible();
});

test('Staff can hand over and take back cars but not confirm, cancel or refund', async ({ page }) => {
  const { code } = demo().bookings.requested; // confirmed by the Manager earlier, pickup tomorrow
  await page.goto(`/admin/bookings/${code}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code);
  await expect(page.getByRole('button', { name: 'Mark picked up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);

  await card(page, 'Payments').getByRole('button', { name: 'Record payment' }).click();
  const types = page.getByRole('dialog', { name: 'Record payment' }).getByLabel('Type');
  await expect(types.locator('option')).toHaveText(['Rent', 'Deposit', 'Extra charge']);
});

test('the data API refuses Staff a customer outside today', async ({ page }) => {
  await page.goto('/admin');
  const res = await page.request.post('/api/query', {
    headers: { 'x-ksr-request': '1' },
    data: { table: 'customers', action: 'select', select: 'full_name', filters: [], order: [] },
  });
  expect(res.ok()).toBe(true);
  const names = ((await res.json()) as { data: Array<{ full_name: string }> }).data.map((c) => c.full_name);
  expect(names).toContain(demo().bookings.pickupToday.customer.name);
  expect(names).not.toContain(demo().bookings.closed.customer.name);
  expect(names).not.toContain(demo().bookings.clashConfirmed.customer.name);
});
