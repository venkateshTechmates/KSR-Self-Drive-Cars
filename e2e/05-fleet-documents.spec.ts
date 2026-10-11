// Fleet and documents (FLT-*, DOC-*): prices that reach the website, maintenance, vehicle
// papers (upload, renew, view through a signed link) and the document centre.
import { expect, test } from '@playwright/test';
import { demoPng } from '../server/png.ts';
import { authFile, card, demo, dialog, istDay } from './helpers.ts';

test.use({ storageState: authFile('manager') });

test('the document centre counts expired papers, expiring papers and documents to verify', async ({ page }) => {
  await page.goto('/admin/documents');
  await expect(page.getByRole('heading', { name: 'Document centre', level: 1 })).toBeVisible();
  const tiles = page.getByRole('region', { name: 'Document alerts' });
  await expect(tiles.getByRole('button', { name: /^1 Vehicle papers expired/ })).toBeVisible();
  await expect(tiles.getByRole('button', { name: /^1 Vehicle papers expiring in 30 days/ })).toBeVisible();
  await expect(tiles.getByRole('button', { name: /^1 Customer documents to verify/ })).toBeVisible();
});

test('a price change shows on the website at once', async ({ page, browser }) => {
  await page.goto(`/admin/fleet/${demo().cars['hyundai-i20']}?tab=prices`);
  const prices = card(page, 'Current prices');
  await expect(prices.getByLabel('12 hr price (₹)')).toHaveValue('1500');
  await prices.getByLabel('12 hr price (₹)').fill('1650');
  await prices.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Prices saved')).toBeVisible();
  await expect(card(page, 'Price history')).toContainText('₹1,650');

  const visitor = await browser.newContext();
  const site = await visitor.newPage();
  await site.goto('/cars/hyundai-i20');
  await expect(site.getByText('₹1,650').first()).toBeVisible();
  await visitor.close();
});

test('the maintenance tab shows the planned service', async ({ page }) => {
  await page.goto(`/admin/fleet/${demo().cars['tata-nexon-new']}?tab=maintenance`);
  const maintenance = card(page, 'Maintenance');
  await expect(maintenance.getByText('Service', { exact: false }).first()).toBeVisible();
  await expect(maintenance.getByText('Periodic service')).toBeVisible();
  await expect(maintenance.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
});

test('a vehicle paper opens through a short-lived signed link', async ({ page }) => {
  await page.goto(`/admin/fleet/${demo().cars['kia-sonet']}?tab=papers`);
  await expect(page.getByText('Expiring within 30 days')).toBeVisible();
  const papers = card(page, 'Vehicle papers');
  await papers.getByRole('button', { name: 'View', exact: true }).first().click();
  const viewer = page.getByRole('dialog').filter({ has: page.locator('img') });
  const img = viewer.locator('img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /\/api\/files\//);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);

  // The signed link works only for a few minutes and only as issued.
  const src = (await img.getAttribute('src'))!;
  const [base, token] = src.split('/api/files/');
  const flipped = token.slice(0, 6) + (token[6] === 'a' ? 'b' : 'a') + token.slice(7);
  const tampered = await page.request.get(`${base}/api/files/${flipped}`);
  expect(tampered.status()).toBeGreaterThanOrEqual(400);
});

test('uploading renewed insurance unblocks confirmation for the car', async ({ page }) => {
  await page.goto(`/admin/fleet/${demo().cars['tata-punch-cng']}?tab=papers`);
  await expect(page.getByText("Bookings for this car can't be confirmed")).toBeVisible();

  const papers = card(page, 'Vehicle papers');
  await papers.getByRole('button', { name: 'Upload', exact: true }).first().click();
  const upload = dialog(page, 'Upload documents');
  await upload.getByLabel('Document type').selectOption('insurance');
  await upload.locator('input[type=file]:not([capture])').setInputFiles({
    name: 'punch-insurance-2027.png',
    mimeType: 'image/png',
    buffer: demoPng(160, 100, [200, 60, 40]),
  });
  await expect(upload.getByText('punch-insurance-2027.png')).toBeVisible();
  await upload.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(upload.getByText('Enter the expiry date.')).toBeVisible();
  await upload.getByLabel(/Expiry date/).fill(istDay(365));
  await upload.getByLabel(/Document number/).fill('POL-77001234');
  await upload.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(upload).toBeHidden();

  await expect(page.getByText("Bookings for this car can't be confirmed")).toBeHidden();
  await expect(papers.getByText('Insurance policy').first()).toBeVisible();
});
