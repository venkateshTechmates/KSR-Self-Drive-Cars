// Booking management (BKA-*, Section 7): dashboard, confirm, clash refusal, reject with a
// reason, expired vehicle papers with the Owner's override, the pickup gate and handover,
// payments and closing.
import { expect, test, type Page } from '@playwright/test';
import { authFile, card, demo, dialog, expectBookingStatus, istDay } from './helpers.ts';

test.describe('as the Manager', () => {
  test.use({ storageState: authFile('manager') });

  test('the dashboard shows requests, overdue cars, today and document alerts', async ({ page }) => {
    const b = demo().bookings;
    await page.goto('/admin');
    const needs = card(page, 'Needs action');
    for (const key of ['requested', 'papersExpired', 'clashRequested', 'toReject'] as const) {
      await expect(needs.getByText(b[key].code)).toBeVisible();
    }
    await expect(needs.getByText(b.clashConfirmed.code)).toHaveCount(0);

    const overdue = card(page, 'Overdue');
    await expect(overdue.getByText(b.overdue.code)).toBeVisible();
    await expect(overdue.getByText('1 car', { exact: true })).toBeVisible();
    await expect(overdue.getByText(b.active.code)).toHaveCount(0);

    await expect(card(page, 'Today').getByText(b.pickupToday.code)).toBeVisible();

    const alerts = card(page, 'Document alerts');
    await expect(alerts.getByText('Tata Punch CNG')).toBeVisible();
    await expect(alerts.getByText('Kia Sonet')).toBeVisible();
    await expect(alerts.getByText(/Insurance policy · expired/)).toBeVisible();
  });

  test('confirming a request; the customer sees it on the lookup page', async ({ page, browser }) => {
    const { code, customer } = demo().bookings.requested;
    await page.goto(`/admin/bookings/${code}`);
    await expectBookingStatus(page, 'Requested');
    await expect(page.getByText('Request sent from the website')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('Booking confirmed')).toBeVisible();
    await expectBookingStatus(page, 'Confirmed');

    const visitor = await browser.newContext();
    const lookup = await visitor.newPage();
    await lookup.goto('/booking-status');
    await lookup.getByLabel('Booking code').fill(code);
    await lookup.getByLabel('Mobile number').fill(customer.phone);
    await lookup.getByRole('button', { name: 'Check status' }).click();
    await expect(lookup.getByText('Confirmed', { exact: true })).toBeVisible();
    await visitor.close();
  });

  test('a clash is refused and names the other booking', async ({ page }) => {
    const { clashRequested, clashConfirmed } = demo().bookings;
    await page.goto(`/admin/bookings/${clashRequested.code}`);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    const issue = dialog(page, "Couldn't confirm this booking");
    await expect(issue).toContainText(`This car is already booked: ${clashConfirmed.code}`);
    await issue.getByRole('link', { name: `Open ${clashConfirmed.code}` }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/bookings/${clashConfirmed.code}$`));
    await expectBookingStatus(page, 'Confirmed');

    // The request is still waiting.
    await page.goto(`/admin/bookings/${clashRequested.code}`);
    await expectBookingStatus(page, 'Requested');
  });

  test('rejecting needs a reason, which is shown on the booking', async ({ page }) => {
    const { code } = demo().bookings.toReject;
    await page.goto(`/admin/bookings/${code}`);
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    const confirm = dialog(page, `Reject ${code}?`);
    await confirm.getByRole('button', { name: 'Reject booking' }).click();
    await expect(confirm.getByText('Give a reason.')).toBeVisible();
    await confirm.getByLabel('Reason').fill('Licence expired before the return date.');
    await confirm.getByRole('button', { name: 'Reject booking' }).click();
    await expect(page.getByText('Booking rejected')).toBeVisible();
    await expectBookingStatus(page, 'Rejected');
    await expect(page.getByText('Licence expired before the return date.').first()).toBeVisible();
  });

  test('expired insurance blocks confirmation for a Manager', async ({ page }) => {
    const { code } = demo().bookings.papersExpired;
    await page.goto(`/admin/bookings/${code}`);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    const issue = dialog(page, "Couldn't confirm this booking");
    await expect(issue).toContainText('Insurance policy for this car expires on');
    await expect(issue).toContainText('ask the Owner to override');
    await expect(issue.getByRole('button', { name: 'Override and confirm' })).toHaveCount(0);
    await issue.getByRole('button', { name: 'Back' }).click();
    await expectBookingStatus(page, 'Requested');
  });

  test('the pickup gate lists the checks; a Manager cannot skip them', async ({ page }) => {
    const { code } = demo().bookings.pickupToday;
    await page.goto(`/admin/bookings/${code}`);
    const checks = card(page, 'Pickup checks');
    await expect(checks.getByText('Verify the driving licence (front photo) first.')).toBeVisible();
    await expect(checks.getByText("Verify the customer's identity (Aadhaar QR, passport or voter ID).")).toBeVisible();

    await page.getByRole('button', { name: 'Mark picked up' }).click();
    const gate = dialog(page, 'Check these before pickup');
    await expect(gate.getByText('Verify the driving licence (front photo) first.')).toBeVisible();
    await expect(gate.getByRole('button', { name: 'Override with reason' })).toHaveCount(0);
    await gate.getByRole('button', { name: 'Back' }).click();
    await expectBookingStatus(page, 'Confirmed');
  });

  test('recording the last payment and closing a returned booking', async ({ page }) => {
    const { code } = demo().bookings.returned;
    await page.goto(`/admin/bookings/${code}`);
    await expectBookingStatus(page, 'Returned');

    await card(page, 'Payments').getByRole('button', { name: 'Record payment' }).click();
    const form = dialog(page, 'Record payment');
    await expect(form.getByLabel('Type')).toHaveValue('rent');
    await expect(form.getByText('Balance due: ₹1,500.')).toBeVisible();
    await form.getByLabel('Amount').fill('1500');
    await form.getByText('UPI', { exact: true }).click();
    await form.getByLabel('Reference').fill('UPI4455667788');
    await form.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByText('Rent of ₹1,500 recorded')).toBeVisible();
    await expect(card(page, 'Payments').getByText('Ref UPI4455667788')).toBeVisible();

    await page.getByRole('button', { name: 'Close booking' }).click();
    const close = dialog(page, `Close ${code}?`);
    await expect(close.getByText('Everything is settled.')).toBeVisible();
    await close.getByRole('button', { name: 'Close booking' }).click();
    await expect(page.getByText('Booking closed')).toBeVisible();
    await expectBookingStatus(page, 'Closed');
  });

  test('an overdue car shows as Overdue', async ({ page }) => {
    await page.goto(`/admin/bookings/${demo().bookings.overdue.code}`);
    await expectBookingStatus(page, 'Overdue');
    await expect(page.getByRole('button', { name: 'Mark returned' })).toBeVisible();
  });

  test('the bookings list finds a past booking by customer name', async ({ page }) => {
    const { code, customer } = demo().bookings.closed;
    await page.goto('/admin/bookings');
    await page.getByRole('group', { name: 'Which bookings' }).getByRole('button', { name: 'All', exact: true }).click();
    const search = page.getByRole('searchbox', { name: 'Search bookings' });
    await search.fill(customer.name);
    await search.press('Enter');
    await expect(page.getByText(code).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText(demo().bookings.requested.code).filter({ visible: true })).toHaveCount(0);
  });
});

test.describe('as the Owner', () => {
  test.use({ storageState: authFile('owner') });

  test('the Owner overrides expired insurance with a reason', async ({ page }) => {
    const { code } = demo().bookings.papersExpired;
    await page.goto(`/admin/bookings/${code}`);
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    const issue = dialog(page, "Couldn't confirm this booking");
    await issue.getByRole('button', { name: 'Override and confirm' }).click();
    await expect(issue.getByText('Give a reason for the override.')).toBeVisible();
    await issue.getByLabel('Reason to confirm anyway').fill('Renewed policy seen on the insurer app; PDF to follow.');
    await issue.getByRole('button', { name: 'Override and confirm' }).click();
    await expectBookingStatus(page, 'Confirmed');
    await expect(page.getByText(/Insurance policy expired .*Reason: Renewed policy seen on the insurer app/)).toBeVisible();
  });

  test('the Owner hands over a car past the pickup gate with a reason', async ({ page }) => {
    const { code } = demo().bookings.pickupToday;
    await page.goto(`/admin/bookings/${code}`);
    await page.getByRole('button', { name: 'Mark picked up' }).click();
    const gate = dialog(page, 'Check these before pickup');
    await gate.getByRole('button', { name: 'Override with reason' }).click();
    await gate.getByLabel('Reason for handing over without these checks').fill('Licence and Aadhaar checked in person; uploads pending.');
    await gate.getByRole('button', { name: 'Continue to handover' }).click();

    const handover = dialog(page, 'Hand over the car');
    await expect(handover.getByText("Handing over with the Owner's override")).toBeVisible();
    await handover.getByRole('button', { name: 'Hand over car' }).click();
    await expect(handover.getByText('Enter the odometer reading in whole km, for example 45210.')).toBeVisible();
    await expect(handover.getByText('Ask the customer to sign in the box.')).toBeVisible();

    await handover.getByLabel(/^Odometer \(km\)/).fill('31250');
    await handover.getByRole('group', { name: /Fuel level/ }).getByText('Full', { exact: true }).click();
    await sign(page, handover.getByRole('img', { name: "Customer's signature" }));
    await expect(handover.getByText('Signature captured.')).toBeVisible();
    await handover.getByLabel("The customer accepted the car's condition and the terms of rental.").check();
    await handover.getByRole('button', { name: 'Hand over car' }).click();

    await expect(page.getByText('Car handed over. The booking is now Active.')).toBeVisible();
    await expectBookingStatus(page, 'Active');
    await expect(page.getByText(/Pickup checks overridden/)).toBeVisible();
  });

  test('the Owner creates a walk-in booking from the admin', async ({ page }) => {
    await page.goto('/admin/bookings/new');
    await expect(page.getByRole('heading', { name: 'New booking', level: 1 })).toBeVisible();
    await page.getByText('Walk-in', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Car', exact: true }).selectOption(demo().cars['hyundai-i20']);
    await page.getByRole('radio', { name: /^12 hrs/ }).check();
    await page.getByRole('textbox', { name: 'Date', exact: true }).fill(istDay(1));
    await page.getByRole('textbox', { name: 'Time', exact: true }).fill('09:15');
    await expect(page.getByText(/Return by: .*9:15 pm/)).toBeVisible();
    await page.getByLabel(/^Mobile number/).fill('91234 56780');
    await page.getByLabel(/^Full name/).fill('Sameer Joshi');
    await page.getByLabel(/^Driving licence number/).fill('MH1220150034567');
    await page.getByRole('button', { name: 'Create booking' }).click();
    await expect(page.getByText('Fix the highlighted fields, then try again.')).toBeVisible();
    await page.getByLabel(/The customer agreed to how we use their details/).check();
    await page.getByRole('button', { name: 'Create booking' }).click();

    await expect(page.getByText(/Booking KSR-\d{6}-\d{3} created\./)).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/bookings\/KSR-\d{6}-\d{3}$/);
    await expectBookingStatus(page, 'Requested');
    await expect(page.getByText('Hyundai i20 · 12 hrs')).toBeVisible();
    await expect(page.getByText('Created by staff (walk-in)')).toBeVisible();
  });
});

/** Draw a short signature on a canvas with the mouse. */
async function sign(page: Page, canvas: import('@playwright/test').Locator) {
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const y = box.y + box.height * 0.55;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.04), y + Math.sin(i) * 18);
  await page.mouse.up();
}
