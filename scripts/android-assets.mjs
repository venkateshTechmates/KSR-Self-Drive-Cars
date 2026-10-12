// Renders the Android app icon and launch screen sources (assets/*.png) from the KSR number-plate
// logo (public/favicon.svg) with Chrome, then generates every Android size with
// @capacitor/assets. Run after changing the logo: npm run android:assets
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const INK = '#1D2125';
const PLATE = '#FFC72C';

/** The plate: yellow border and "KSR" on black, drawn in a size×size box. */
const plate = (size) => `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
    <rect width="64" height="64" rx="12" fill="#000"/>
    <rect x="4" y="4" width="56" height="56" rx="9" fill="none" stroke="${PLATE}" stroke-width="3"/>
    <text x="32" y="42" text-anchor="middle" font-family="Arial Narrow, Arial, sans-serif" font-weight="800"
      font-size="26" fill="${PLATE}" letter-spacing="1">KSR</text>
  </svg>`;

const pages = [
  // Legacy icon (Android 7): the plate on black, small enough that a round mask keeps its border.
  {
    file: 'assets/icon-only.png',
    size: 1024,
    body: `<div style="width:1024px;height:1024px;background:#000;display:flex;align-items:center;justify-content:center">${plate(800)}</div>`,
    transparent: false,
  },
  // Adaptive icon foreground: @capacitor/assets insets it into the 66% safe zone, so the plate
  // fills the layer.
  {
    file: 'assets/icon-foreground.png',
    size: 1024,
    body: `<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center">${plate(1000)}</div>`,
    transparent: true,
  },
  { file: 'assets/icon-background.png', size: 1024, body: '<div style="width:1024px;height:1024px;background:#000"></div>', transparent: false },
  // Launch screen: the plate on ink (same in light and dark mode).
  ...['assets/splash.png', 'assets/splash-dark.png'].map((file) => ({
    file,
    size: 2732,
    body: `<div style="width:2732px;height:2732px;background:${INK};display:flex;align-items:center;justify-content:center">${plate(640)}</div>`,
    transparent: false,
  })),
];

mkdirSync('assets', { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
for (const p of pages) {
  const page = await browser.newPage({ viewport: { width: p.size, height: p.size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${p.body}</body></html>`);
  await page.screenshot({ path: p.file, omitBackground: p.transparent, clip: { x: 0, y: 0, width: p.size, height: p.size } });
  await page.close();
  console.info(`rendered ${p.file}`);
}
await browser.close();

execSync(
  `npx --yes @capacitor/assets@3.0.5 generate --android --iconBackgroundColor "#000000" --splashBackgroundColor "${INK}" --splashBackgroundColorDark "${INK}"`,
  { stdio: 'inherit' },
);
