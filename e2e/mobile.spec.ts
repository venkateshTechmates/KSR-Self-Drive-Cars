// Phone-sized checks (Pixel 7): the compact fleet cards, the full-screen booking sheet with
// the car carousel, and the admin's menu drawer.
import { expect, test } from '@playwright/test';
import { authFile, bookingOverlay, istDay } from './helpers.ts';

test('the fleet uses compact cards and short filter labels', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Showing all 11 cars')).toBeVisible();
  const filters = page.getByRole('group', { name: 'Filter cars by type' });
  await expect(filters.getByRole('button', { name: /^SUVs 6/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Book Kia Sonet' })).toHaveText('Book');
  // No sideways scrolling on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('booking on a phone: full-screen sheet with the car carousel', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Book Kia Sonet' }).click();
  const sheet = bookingOverlay(page);
  await expect(sheet.getByRole('heading', { name: 'Book a car', level: 1 })).toBeVisible();
  const carousel = sheet.getByRole('group', { name: 'Car' });
  await expect(carousel.getByRole('button', { name: /Kia Sonet/ })).toHaveAttribute('aria-pressed', 'true');
  await carousel.getByRole('button', { name: /Toyota Glanza/ }).click();
  await expect(carousel.getByRole('button', { name: /Toyota Glanza/ })).toHaveAttribute('aria-pressed', 'true');

  await sheet.getByLabel('Pickup date').fill(istDay(12));
  await sheet.getByLabel('Pickup time').selectOption('11:00');
  await sheet.getByLabel('Full name', { exact: true }).fill('Kavya Iyer');
  await sheet.getByLabel('Mobile number', { exact: true }).fill('70123 45678');
  await sheet.getByLabel('Driving licence number', { exact: true }).fill('TN0920200012345');
  await sheet.getByRole('checkbox', { name: /I agree/ }).check();
  await sheet.getByRole('button', { name: 'Request booking' }).click();
  await expect(sheet.getByRole('status').getByRole('heading', { name: 'Request sent' })).toBeVisible();
  await expect(sheet.getByRole('status')).toContainText('Toyota Glanza');

  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test.describe('admin on a phone', () => {
  test.use({ storageState: authFile('manager') });

  test('the menu drawer opens, navigates and closes', async ({ page }) => {
    await page.goto('/admin/bookings');
    await expect(page.getByRole('heading', { name: 'Bookings', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: 'Fleet' }).click();
    await expect(page).toHaveURL(/\/admin\/fleet$/);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Fleet', level: 1 })).toBeVisible();
  });
});
