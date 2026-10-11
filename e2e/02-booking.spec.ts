// Customer booking flow (BK-*): validation, a request that reaches the admin, clashes with
// alternatives, cars in maintenance, and the booking lookup page.
import { expect, test, type Page } from '@playwright/test';
import { authFile, bookingOverlay, demo, istDay, localPhone } from './helpers.ts';

async function fillDetails(page: Page, d: { name: string; phone: string; dl: string; email?: string }) {
  const form = bookingOverlay(page);
  await form.getByLabel('Full name', { exact: true }).fill(d.name);
  await form.getByLabel('Mobile number', { exact: true }).fill(d.phone);
  await form.getByLabel('Driving licence number', { exact: true }).fill(d.dl);
  if (d.email) await form.getByLabel(/^Email/).fill(d.email);
  await form.getByRole('checkbox', { name: /I agree/ }).check();
}

async function choosePickup(page: Page, date: string, time: string) {
  const form = bookingOverlay(page);
  await form.getByLabel('Pickup date').fill(date);
  await form.getByLabel('Pickup time').selectOption(time);
}

const submit = (page: Page) => bookingOverlay(page).getByRole('button', { name: 'Request booking' }).click();

test('the form explains every missing or wrong field', async ({ page }) => {
  await page.goto('/book/hyundai-i20');
  const form = bookingOverlay(page);
  await expect(form).toBeVisible();
  await expect(form.getByRole('heading', { name: 'Book Hyundai i20' })).toBeVisible();

  await submit(page);
  await expect(form.getByText('Choose a pickup date and time.')).toBeVisible();
  await expect(form.getByText('Enter your full name.')).toBeVisible();
  await expect(form.getByText('Enter your mobile number.')).toBeVisible();
  await expect(form.getByText('Enter your driving licence number.')).toBeVisible();
  await expect(form.getByText('Tick the box to agree to how we use your details for this booking.')).toBeVisible();

  await form.getByLabel('Mobile number', { exact: true }).fill('12345');
  await form.getByLabel('Full name', { exact: true }).fill('R2D2');
  await form.getByLabel('Driving licence number', { exact: true }).fill('ab');
  await submit(page);
  await expect(form.getByText('Enter a 10-digit mobile number starting with 6, 7, 8 or 9.')).toBeVisible();
  await expect(form.getByText('Use 2–80 letters. Spaces, full stops, apostrophes and hyphens are fine.')).toBeVisible();
  await expect(form.getByText(/Enter your driving licence number as printed/)).toBeVisible();

  // Escape closes the overlay and returns to the home page.
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/);
});

test('a customer books a car, checks the status, and the request reaches the admin', async ({ page, browser }) => {
  const date = istDay(6);
  await page.goto('/');
  await page.getByRole('button', { name: 'Book Maruti Suzuki Fronx' }).click();
  await expect(page).toHaveURL(/\/book\/maruti-suzuki-fronx$/);
  const form = bookingOverlay(page);
  await form.getByRole('radio', { name: /^24 hrs/ }).check();
  await choosePickup(page, date, '10:00');
  await expect(form.getByRole('complementary', { name: 'Your booking' })).toContainText('₹2,500');
  await fillDetails(page, { name: 'Neha Gupta', phone: '98480 22334', dl: 'TS0920190012777', email: 'neha@example.com' });
  await submit(page);

  const confirmation = form.getByRole('status');
  await expect(confirmation.getByRole('heading', { name: 'Request sent' })).toBeVisible();
  const code = (await confirmation.locator('strong.font-mono').textContent())!.trim();
  expect(code).toMatch(/^KSR-\d{6}-\d{3}$/);
  await expect(confirmation).toContainText('98480 22334');
  await expect(confirmation).toContainText('Maruti Suzuki Fronx');

  // Booking lookup (5.5).
  await page.goto('/booking-status');
  await page.getByLabel('Booking code').fill(code.toLowerCase());
  await page.getByLabel('Mobile number').fill('+91 98480 22334');
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText(code, { exact: true })).toBeVisible();
  await expect(page.getByText('Requested', { exact: true })).toBeVisible();

  // The wrong number finds nothing (and says nothing about the booking).
  await page.getByLabel('Mobile number').fill('98480 99999');
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText("We couldn't find a booking with that code and mobile number.")).toBeVisible();

  // The Manager sees the new request with the price that was shown to the customer.
  const admin = await browser.newContext({ storageState: authFile('manager') });
  const adminPage = await admin.newPage();
  await adminPage.goto('/admin');
  await expect(adminPage.locator('section').filter({ hasText: 'Needs action' }).getByText(code)).toBeVisible();
  await adminPage.goto(`/admin/bookings/${code}`);
  await expect(adminPage.getByRole('heading', { level: 1 })).toContainText('Requested');
  await expect(adminPage.getByText('Maruti Suzuki Fronx · 24 hrs')).toBeVisible();
  await expect(adminPage.getByText(/^Website · created/)).toBeVisible();
  await expect(adminPage.getByText('Neha Gupta').first()).toBeVisible();
  await admin.close();
});

test('a clash is refused with free alternatives, and an alternative can be booked', async ({ page }) => {
  const xl6 = demo().bookings.clashConfirmed; // confirmed: day 3, 10:00 for 24 hrs
  await page.goto('/book/maruti-xl6-cng');
  const form = bookingOverlay(page);
  await form.getByRole('radio', { name: /^12 hrs/ }).check();
  await choosePickup(page, istDay(3), '12:00');
  // The busy-car hint shows before sending.
  await expect(form.getByText('Booked at this time', { exact: true }).filter({ visible: true })).toBeVisible();

  await fillDetails(page, { name: 'Arjun Das', phone: '90000 11122', dl: 'TS0920180044556' });
  await submit(page);
  const alert = form.getByRole('alert').filter({ hasText: 'This car is booked at that time. Try another time or another car.' });
  await expect(alert).toBeVisible();
  // No booking codes or times leak to the public (only alternatives).
  await expect(alert).not.toContainText(xl6.code);
  await expect(alert.getByText('These cars are free at that time:')).toBeVisible();

  const alternative = alert.getByRole('button').first();
  const altName = (await alternative.textContent())!.split('·')[0].trim();
  await alternative.click();
  await expect(form.getByLabel('Car', { exact: true }).locator('option:checked')).toContainText(altName);
  await submit(page);
  await expect(form.getByRole('status').getByRole('heading', { name: 'Request sent' })).toBeVisible();
  await expect(form.getByRole('status')).toContainText(altName);
});

test('a car in maintenance shows as not available on that date', async ({ page }) => {
  await page.goto('/book/tata-nexon-new');
  const form = bookingOverlay(page);
  await choosePickup(page, istDay(1), '10:00');
  await expect(form.getByText('Not available on this date', { exact: true }).filter({ visible: true })).toBeVisible();
});

test('a returning customer can send another request with the same number', async ({ page }) => {
  const d = demo().bookings.requested.customer;
  await page.goto('/book/maruti-baleno');
  await choosePickup(page, istDay(9), '15:30');
  await fillDetails(page, { name: d.name, phone: localPhone(d.phone), dl: 'TS0920110012345' });
  await submit(page);
  await expect(bookingOverlay(page).getByRole('status').getByRole('heading', { name: 'Request sent' })).toBeVisible();
});
