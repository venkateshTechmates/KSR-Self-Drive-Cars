// Inside the Android app (Capacitor, see capacitor.config.ts) the site runs in a web view.
// These adaptations make it behave like an app: the back button, links that would open a new
// tab, and (with ./download.ts) saving files. In a browser none of this runs, and the plugin
// code is never downloaded.

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

/** True inside the Android app with its native bridge (window.Capacitor): plugins work. */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor?.isNativePlatform?.());
}

/** Marker the app adds to its user agent (capacitor.config.ts → appendUserAgent). */
export const APP_USER_AGENT = 'KSRApp';

/**
 * True inside the Android app, for what the page shows (the Staff button). Also checks the
 * user agent, so the app is recognised even if the bridge is missing on some phone.
 */
export function isAppWebView(): boolean {
  if (typeof navigator === 'undefined') return false;
  return isNativeApp() || navigator.userAgent.includes(APP_USER_AGENT);
}

/**
 * The Android back button: close the top dialog (as Escape would, so a dialog that is saving
 * stays open), else close the menu drawer, else go back a page, else leave the app.
 */
export function handleBackButton(canGoBack: boolean, exitApp: () => void): void {
  const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  const top = dialogs[dialogs.length - 1];
  if (top) {
    // Our dialogs handle 'cancel' themselves; close any other one natively.
    if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
    return;
  }
  const drawer = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  const closeDrawer = drawer?.querySelector<HTMLButtonElement>('button[aria-label^="Close"]');
  if (closeDrawer) {
    closeDrawer.click();
    return;
  }
  if (canGoBack) window.history.back();
  else exitApp();
}

/**
 * The web view has no tabs. Links to other sites and apps (WhatsApp, Maps, the dialer) are
 * opened outside the app by Capacitor. Our own pages marked "new tab" open in an in-app
 * browser (policies, so a half-filled booking form stays as it is) or, for the admin, here.
 */
export function newTabTarget(href: string, here: string): 'external' | 'browser' | 'same-view' {
  const url = new URL(href, here);
  if (url.origin !== new URL(here).origin) return 'external';
  return url.pathname.startsWith('/admin') ? 'same-view' : 'browser';
}

function onLinkClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0) return;
  const link = (e.target as Element | null)?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null;
  if (!link?.href) return;
  const target = newTabTarget(link.href, window.location.href);
  if (target === 'external') return;
  e.preventDefault();
  if (target === 'same-view') window.location.assign(link.href);
  else void import('@capacitor/browser').then(({ Browser }) => Browser.open({ url: link.href, toolbarColor: '#1d2125' }));
}

/** Call once at start-up. Does nothing in a browser. */
export async function initNativeApp(): Promise<void> {
  if (!isNativeApp()) return;
  document.documentElement.classList.add('native-app');
  document.addEventListener('click', onLinkClick, true);
  // Each step on its own: one plugin failing must not stop the others (or the site).
  try {
    const { App } = await import('@capacitor/app');
    await App.addListener('backButton', ({ canGoBack }) => handleBackButton(canGoBack, () => void App.exitApp()));
  } catch (err) {
    console.warn('[app] back button not set up:', (err as Error)?.message);
  }
  try {
    // Files kept for the share sheet are removed on the next start (see ./download.ts).
    const { clearSharedFiles } = await import('./download');
    await clearSharedFiles();
  } catch (err) {
    console.warn('[app] shared files not cleared:', (err as Error)?.message);
  }
}
