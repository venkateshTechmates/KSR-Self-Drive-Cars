// Public website: fleet, prices, filters, car pages, policies, SEO files (WEB-*, FLE-*).
import { expect, test } from '@playwright/test';

const carCard = (page: import('@playwright/test').Page, name: string) =>
  page.locator('article').filter({ has: page.getByRole('link', { name, exact: true }) });

test('home page shows all 11 cars with 12 hr prices and the lowest price', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/11 well-maintained cars .* from ₹1,300/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Our fleet' })).toBeVisible();
  await expect(page.getByText('Showing all 11 cars')).toBeVisible();
  await expect(page.locator('#fleet article')).toHaveCount(11);

  const sonet = carCard(page, 'Kia Sonet');
  await expect(sonet).toContainText('₹1,800');
  await expect(sonet).toContainText('₹3,500');
  await expect(sonet).toContainText('Premium');
});

test('the 12/24 hr toggle swaps the main price', async ({ page }) => {
  await page.goto('/');
  const ertiga = carCard(page, 'Ertiga (7 Seater)');
  const plate = ertiga.locator('.sm\\:flex').getByText(/^₹/).first();
  await expect(plate).toHaveText('₹2,000');
  await page.getByRole('group', { name: 'Show prices for' }).getByRole('button', { name: /^24 hr/ }).click();
  await expect(plate).toHaveText('₹3,500');
});

test('filters narrow the fleet and show counts', async ({ page }) => {
  await page.goto('/');
  const filters = page.getByRole('group', { name: 'Filter cars by type' });
  await expect(filters.getByRole('button', { name: /^Hatchbacks/ })).toContainText('3');

  await filters.getByRole('button', { name: /^CNG/ }).click();
  await expect(filters.getByRole('button', { name: /^CNG/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Showing 3 of 11 cars')).toBeVisible();
  await expect(page.locator('#fleet article')).toHaveCount(3);
  for (const name of ['Victoris CNG', 'Tata Punch CNG', 'XL6 CNG']) await expect(carCard(page, name)).toBeVisible();

  await filters.getByRole('button', { name: /^6–7 seaters/ }).click();
  await expect(page.getByText('Showing 2 of 11 cars')).toBeVisible();
  await filters.getByRole('button', { name: /^All cars/ }).click();
  await expect(page.getByText('Showing all 11 cars')).toBeVisible();
});

test('a car page shows its specs, prices and a booking button', async ({ page }) => {
  await page.goto('/');
  await carCard(page, 'Toyota Glanza').getByRole('link', { name: 'Toyota Glanza' }).click();
  await expect(page).toHaveURL(/\/cars\/toyota-glanza$/);
  await expect(page.getByRole('heading', { name: 'Toyota Glanza', level: 1 })).toBeVisible();
  await expect(page.getByText('₹1,500').first()).toBeVisible();
  await expect(page.getByText('₹2,500').first()).toBeVisible();
  await expect(page).toHaveTitle(/Toyota Glanza/);
});

test('policy pages and the 404 page', async ({ page }) => {
  for (const [path, heading] of [
    ['/privacy', /privacy/i],
    ['/terms', /terms/i],
    ['/cancellation', /cancel/i],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
  }
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /home|fleet|cars/i }).first()).toBeVisible();
});

test('robots.txt and the sitemap list the live car pages', async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain('Disallow: /admin');

  const sitemap = await request.get('/sitemap.xml');
  const xml = await sitemap.text();
  expect(sitemap.headers()['content-type']).toContain('application/xml');
  expect(xml.match(/<loc>[^<]*\/cars\//g)).toHaveLength(11);
});

test('security headers are set and the admin API needs a session', async ({ request }) => {
  const home = await request.get('/');
  expect(home.headers()['x-frame-options']).toBe('DENY');
  expect(home.headers()['x-content-type-options']).toBe('nosniff');

  const bookings = await request.post('/api/query', {
    headers: { 'x-ksr-request': '1' },
    data: { table: 'bookings', action: 'select', select: '*', filters: [], order: [] },
  });
  expect(bookings.status()).toBe(401);

  const noCsrfHeader = await request.post('/api/auth/login', { data: { email: 'a@b.co', password: 'x' } });
  expect(noCsrfHeader.status()).toBe(403);
});
