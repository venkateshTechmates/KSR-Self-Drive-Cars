// Shared helpers for the end-to-end specs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import type { DemoResult } from '../server/demo.ts';
import { totpCode } from '../server/auth/totp.ts';
import { addDaysIso, istDateIso } from '../shared/time.ts';
import { E2E } from './env.ts';

let cached: DemoResult | null = null;

/** The demo data the e2e server seeded (read once the server has started). */
export function demo(): DemoResult {
  cached ??= JSON.parse(readFileSync(join(E2E.dataDir, 'demo.json'), 'utf8')) as DemoResult;
  return cached;
}

export const authFile = (who: 'owner' | 'manager' | 'staff') => join(E2E.authDir, `${who}.json`);
export const ownerSecretFile = () => join(E2E.authDir, 'owner-totp.txt');

/** A current authenticator code for a base32 secret. */
export const totp = (secret: string) => totpCode(secret);

/** IST calendar date `days` from today, as YYYY-MM-DD (what a date input takes). */
export const istDay = (days: number) => addDaysIso(istDateIso(), days);

/** "+919876500004" → "98765 00004" (how the admin shows a number is not needed; the form accepts this). */
export const localPhone = (e164: string) => `${e164.slice(3, 8)} ${e164.slice(8)}`;

export async function signIn(page: Page, email: string, password: string = E2E.password) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function enterCode(page: Page, code: string) {
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
}

/** A card on an admin page, found by its heading. */
export const card = (page: Page, title: string): Locator =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

/** The open dialog with this title. */
export const dialog = (page: Page, title: string | RegExp): Locator => page.getByRole('dialog', { name: title });

/** The status pill next to the booking code on a booking page. */
export async function expectBookingStatus(page: Page, status: string) {
  await expect(page.getByRole('heading', { level: 1 })).toContainText(status);
}

/** The visible booking overlay (desktop modal or phone sheet). */
export const bookingOverlay = (page: Page): Locator => page.locator('dialog[open]');
