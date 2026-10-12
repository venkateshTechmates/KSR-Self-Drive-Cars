// The Android app (Capacitor): a native shell that opens the KSR website, so customers book
// and staff use the admin in one app, and every website deploy reaches the app at once.
// See Docs/ANDROID.md.
//
//   KSR_APP_URL   the site the app opens, read when you run `npm run android:sync`.
//                 Default http://localhost:8080 = `npm run dev` on this computer, reached from
//                 a USB phone or the emulator through `adb reverse` (npm run android:dev).
//                 Set it to the live https address before building a release.
import type { CapacitorConfig } from '@capacitor/cli';

const url = (process.env.KSR_APP_URL ?? 'http://localhost:8080').replace(/\/+$/, '');

const config: CapacitorConfig = {
  appId: 'com.ksrselfdrivecars.app',
  appName: 'KSR Self Drive Cars',
  // Only the offline page ships inside the app; everything else comes from the site.
  webDir: 'app-shell',
  backgroundColor: '#1d2125',
  // Lets the site recognise the app (src/lib/native.ts → isAppWebView).
  appendUserAgent: 'KSRApp',
  server: {
    url,
    // Plain http is allowed only while the app points at a development server.
    cleartext: url.startsWith('http://'),
    errorPath: 'offline.html',
  },
  plugins: {
    // MainActivity keeps the page inside the safe area (below the status bar, above the
    // navigation bar and the keyboard), so Capacitor's own handling is off.
    SystemBars: { insetsHandling: 'disable' },
  },
};

export default config;
